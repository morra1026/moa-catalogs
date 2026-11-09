import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectCatalog, publishedKinds } from './collect.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
const count = (data) =>
  data.items.length || data.groups.reduce((sum, group) => sum + group.names.length, 0);
export function encodeCatalog(kind, data) {
  return JSON.stringify(
    kind === 'fund'
      ? {
          ...data,
          itemFormat: 'fund-tuples-v1',
          items: data.items.map((item) => [item.name, item.symbol, item.aliases ?? '']),
        }
      : data,
  );
}
export function decodeCatalog(kind, text) {
  const data = JSON.parse(text);
  if (data.itemFormat !== undefined) {
    if (kind !== 'fund' || data.itemFormat !== 'fund-tuples-v1' || !Array.isArray(data.items))
      throw new Error('배포 항목 형식 오류');
    data.items = data.items.map((row) => {
      if (!Array.isArray(row) || row.length !== 3 || row.some((part) => typeof part !== 'string'))
        throw new Error('배포 펀드 항목 형식 오류');
      const [name, symbol, aliases] = row;
      return { kind: 'fund', name, symbol, market: 'FUND', currency: 'KRW', aliases };
    });
    delete data.itemFormat;
  }
  return data;
}
function validate(kind, data) {
  if (
    !data ||
    data.asOfKind !== 'source' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.asOf) ||
    !data.source ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.groups) ||
    !count(data)
  )
    throw new Error('배포 데이터 형식 오류');
  if (
    kind === 'fund' &&
    (data.groups.length ||
      data.items.some(
        (item) =>
          item.kind !== 'fund' ||
          !item.name ||
          !item.symbol ||
          item.market !== 'FUND' ||
          item.currency !== 'KRW',
      ))
  )
    throw new Error('펀드 데이터 형식 오류');
  if (kind === 'institutions' && (data.items.length || !data.groups.length))
    throw new Error('금융기관 데이터 형식 오류');
}
function safeBase(base) {
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('CATALOG_BASE_URL은 인증정보 없는 HTTPS 주소여야 합니다.');
  return url;
}
export async function previousRelease(base, fetcher = fetch) {
  if (!base) return { manifest: { version: 1, catalogs: {} }, files: new Map() };
  const url = safeBase(base);
  const read = async (name) => {
    const response = await fetcher(new URL(name, url), {
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error('기존 배포를 읽지 못했습니다. 이전 목록 유실을 막기 위해 배포를 중단합니다.');
    const text = await response.text();
    if (text.length > 24 * 1024 * 1024) throw new Error('기존 배포 파일 크기 초과');
    return text;
  };
  const manifest = JSON.parse(await read('manifest.json'));
  if (manifest.version !== 1 || !manifest.catalogs) throw new Error('기존 배포 버전 오류');
  const files = new Map();
  for (const [kind, entry] of Object.entries(manifest.catalogs)) {
    if (
      !publishedKinds.includes(kind) ||
      !/^[a-f0-9]{64}$/.test(entry.revision) ||
      entry.file !== `${kind}-${entry.revision}.json`
    )
      throw new Error('기존 배포의 파일 또는 출처 오류');
    const text = await read(entry.file);
    const data = decodeCatalog(kind, text);
    validate(kind, data);
    if (digest(text) !== entry.revision || data.asOf !== entry.asOf || count(data) !== entry.count)
      throw new Error('기존 배포의 무결성 오류');
    files.set(entry.file, text);
  }
  return { manifest, files };
}
export async function buildRelease({ previous, loaders, now = new Date() }) {
  const catalogs = { ...previous.manifest.catalogs };
  const files = new Map(previous.files);
  const failures = [];
  for (const kind of publishedKinds) {
    try {
      const data = await loaders[kind]();
      validate(kind, data);
      const old = catalogs[kind];
      if (old && (data.asOf < old.asOf || count(data) < old.count * 0.8))
        throw new Error('원본 기준일 역행 또는 목록 개수 급감');
      // Collection time alone must not force every app to download an unchanged list.
      const oldData = old && decodeCatalog(kind, files.get(old.file));
      if (
        oldData &&
        JSON.stringify({ ...oldData, collectedAt: '' }) ===
          JSON.stringify({ ...data, collectedAt: '' })
      )
        continue;
      const text = encodeCatalog(kind, data);
      if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw new Error('배포 파일 크기 초과');
      const revision = digest(text);
      const file = `${kind}-${revision}.json`;
      files.set(file, text);
      catalogs[kind] = { revision, file, count: count(data), asOf: data.asOf };
    } catch {
      // Only fixed messages leave the collector. No API response or authenticated URL
      // can accidentally reach a public manifest, workflow log or Actions summary.
      failures.push(kind);
    }
  }
  if (!Object.keys(catalogs).length)
    throw new Error('배포 가능한 목록이 없습니다. 인증키와 활용신청을 확인하세요.');
  return { manifest: { version: 1, generatedAt: now.toISOString(), catalogs }, files, failures };
}
async function main() {
  if (!process.env.CATALOG_BASE_URL && process.env.CATALOG_BOOTSTRAP !== '1')
    throw new Error('첫 배포만 CATALOG_BOOTSTRAP=1로 실행할 수 있습니다.');
  const previous = await previousRelease(process.env.CATALOG_BASE_URL);
  const result = await buildRelease({
    previous,
    loaders: Object.fromEntries(
      publishedKinds.map((kind) => [
        kind,
        () => collectCatalog(kind, process.env.DATA_GO_KR_SERVICE_KEY),
      ]),
    ),
  });
  const output = resolve('catalog-service/public');
  await mkdir(output, { recursive: true });
  // Keep current and immediately preceding snapshots. Static deployments are atomic;
  // clients holding the old manifest briefly can still fetch its immutable files.
  for (const [name, text] of result.files) await writeFile(resolve(output, name), text);
  await writeFile(
    resolve(output, '_headers'),
    '/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=300\n/manifest.json\n  Cache-Control: no-cache\n',
  );
  await writeFile(
    resolve(output, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>모아 공개 검색 목록</title><p>금융위원회 공공데이터 기반 금융기관·펀드 검색 목록. 원본 기준일과 출처는 각 JSON 파일에 표시됩니다.</p><a href="manifest.json">목록 버전 확인</a>',
  );
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(result.manifest));
  // Keep the report outside public/. Workflow deploys successful lists first, then
  // reports partial failure without sacrificing the last working list.
  await writeFile(
    resolve('catalog-service/report.json'),
    JSON.stringify({ failures: result.failures }),
  );
  console.log(
    JSON.stringify({
      published: Object.keys(result.manifest.catalogs),
      retainedAfterFailure: result.failures,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      '목록 생성 실패: 인증키·활용신청·기존 배포 주소를 확인하세요. 원문 오류는 키 보호를 위해 출력하지 않습니다.',
    );
    process.exitCode = 1;
  });
}

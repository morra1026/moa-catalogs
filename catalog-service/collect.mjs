// Runs in Node on the scheduled runner only. Never imported by the Expo app.
// API contracts: data.go.kr/data/15043232/openapi.do and /15094792/openapi.do.
import { setTimeout as delay } from 'node:timers/promises';
// Only messages constructed here are safe for public workflow diagnostics.
export class CollectionError extends Error {}

async function requestJson(url, fetcher) {
  let failure = '공공 API 연결 실패';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(55000) });
      if (!response.ok) {
        failure = `공공 API HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) throw new CollectionError(failure);
        await response.body?.cancel();
      } else {
        try {
          return await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new CollectionError('공공 API JSON 응답 오류');
          failure = '공공 API 응답 수신 실패';
        }
      }
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      // Fetch errors may contain the authenticated URL. Never log or propagate them.
      failure = '공공 API 연결 실패';
    }
    if (attempt < 2) await delay(500 * (attempt + 1));
  }
  throw new CollectionError(failure);
}
const definitions = {
  institutions: {
    endpoint: 'https://apis.data.go.kr/1160100/service/GetFnCoBasiInfoService/getFnCoOutl',
    keyParam: 'ServiceKey',
    source: '금융위원회 금융회사기본정보 · 앱 보완 목록',
    sourceUrl: 'https://www.data.go.kr/data/15043232/openapi.do',
    minimum: 30,
  },
  fund: {
    endpoint:
      'https://apis.data.go.kr/1160100/service/GetFundProductInfoService/getStandardCodeInfo',
    keyParam: 'serviceKey',
    source: '금융위원회 펀드상품기본정보 · 금융투자협회',
    sourceUrl: 'https://www.data.go.kr/data/15094792/openapi.do',
    minimum: 100,
  },
};
export const publishedKinds = Object.keys(definitions);
const maxRows = 300000;
const pageSize = 1000;
const isoDay = (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
function requiredText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new CollectionError(`${label}: 원본 필드 형식 오류`);
  return value.trim();
}
export function normalizeServiceKey(key) {
  if (!key?.trim()) throw new CollectionError('DATA_GO_KR_SERVICE_KEY 설정이 필요합니다.');
  // The portal displays both encoded and decoded keys. Decode percent escapes once,
  // then URLSearchParams performs the request encoding. Never interpret + as a space.
  try {
    return key.includes('%') ? decodeURIComponent(key.trim()) : key.trim();
  } catch {
    throw new CollectionError('공공데이터 인증키 인코딩을 확인해 주세요.');
  }
}
async function page(definition, key, day, pageNo, fetcher, endDay) {
  const url = new URL(definition.endpoint);
  for (const [name, value] of Object.entries({
    [definition.keyParam]: key,
    resultType: 'json',
    numOfRows: String(endDay ? 10000 : pageSize),
    pageNo: String(pageNo),
    ...(endDay ? { endBasDt: endDay } : { basDt: day }),
  }))
    url.searchParams.set(name, value);
  const value = await requestJson(url, fetcher);
  const result = value?.response;
  if (String(result?.header?.resultCode) !== '00')
    throw new CollectionError('공공 API 인증 또는 응답 오류: 활용신청·한도를 확인하세요.');
  const body = result.body;
  const total = Number(body?.totalCount);
  if (!Number.isSafeInteger(total) || total < 0 || total > maxRows)
    throw new CollectionError('공공 API 전체 개수 오류');
  if (
    Number(body.pageNo) !== pageNo ||
    !Number.isInteger(Number(body.numOfRows)) ||
    Number(body.numOfRows) < 1
  )
    throw new CollectionError('공공 API 페이지 정보 오류');
  const item = body.items?.item;
  const rows = item ? (Array.isArray(item) ? item : [item]) : [];
  if (
    rows.some((row) =>
      endDay
        ? typeof row?.basDt !== 'string' || !/^\d{8}$/.test(row.basDt) || row.basDt >= endDay
        : row?.basDt !== day,
    ) ||
    (total > 0 && !rows.length) ||
    (!total && rows.length)
  )
    throw new CollectionError('공공 API 기준일 또는 페이지 내용 오류');
  return { total, rows };
}

const institutionAliases = {
  국민은행: 'KB국민은행',
  농협은행: 'NH농협은행',
  중소기업은행: 'IBK기업은행',
  한국산업은행: 'KDB산업은행',
  수협은행: 'Sh수협은행',
  한국스탠다드차타드은행: 'SC제일은행',
  아이엠뱅크: 'iM뱅크',
  아이엠증권: 'iM증권',
};
export function transformRows(kind, rows, day, collectedAt) {
  const definition = definitions[kind];
  if (!definition)
    throw new CollectionError('재배포 허용을 확인한 공공 목록만 수집할 수 있습니다.');
  const common = {
    asOf: isoDay(day),
    asOfKind: 'source',
    collectedAt,
    source: definition.source,
    sourceUrl: definition.sourceUrl,
  };
  if (kind === 'fund') {
    const byCode = new Map();
    for (const row of rows) {
      const symbol = requiredText(row.asoStdCd, '협회표준코드', 30);
      if (!/^[A-Za-z0-9]+$/.test(symbol)) throw new CollectionError('펀드 표준코드 형식 오류');
      const name = requiredText(row.fndNm, '펀드명');
      const previous = byCode.get(symbol);
      if (previous && previous.name !== name)
        throw new CollectionError('펀드 코드에 서로 다른 이름이 있습니다.');
      byCode.set(symbol, {
        kind: 'fund',
        name,
        symbol,
        market: 'FUND',
        currency: 'KRW',
        aliases: typeof row.srtnCd === 'string' ? row.srtnCd.trim() : '',
      });
    }
    return {
      ...common,
      groups: [],
      items: [...byCode.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    };
  }
  const names = new Set();
  for (const row of rows) {
    const raw = requiredText(row.fncoNm, '금융회사명')
      .replace(/^(?:주식회사|\(주\))\s*|\s*(?:주식회사|\(주\))$/g, '')
      .trim();
    names.add(institutionAliases[raw] ?? raw);
  }
  // Supplemental selection aids are not claimed to be part of the FSC registry.
  for (const name of [
    '우체국예금보험',
    '지역농축협',
    '새마을금고',
    '신협',
    '수협중앙회',
    '산림조합',
  ])
    names.add(name);
  const groups = ['은행', '증권사', '상호금융', '기타 금융회사'].map((label) => ({
    label,
    names: [],
  }));
  for (const name of [...names].sort((a, b) => a.localeCompare(b, 'ko'))) {
    const index = /은행|뱅크|우체국/.test(name)
      ? 0
      : /증권|금융투자/.test(name)
        ? 1
        : /농축협|새마을금고|신협|수협중앙회|산림조합/.test(name)
          ? 2
          : 3;
    groups[index].names.push(name);
  }
  return { ...common, items: [], groups };
}

export async function collectCatalog(
  kind,
  serviceKey,
  { fetcher = fetch, now = new Date(), lookback = 14 } = {},
) {
  const definition = definitions[kind];
  if (!definition) throw new CollectionError('지원하지 않는 공공 목록');
  const key = normalizeServiceKey(serviceKey);
  const koreanDay = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (kind === 'fund') {
    // basDt filters each code's last update, not a complete daily snapshot.
    // Read the whole registry, bounded by tomorrow's exclusive date.
    const endDay = new Date(Date.parse(`${koreanDay}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    const first = await page(definition, key, undefined, 1, fetcher, endDay);
    const rows = [...first.rows];
    const seenPages = new Set([JSON.stringify(first.rows)]);
    for (let pageNo = 2; rows.length < first.total; pageNo++) {
      if (pageNo > 1000) throw new CollectionError('공공 API 페이지 한도 초과');
      const next = await page(definition, key, undefined, pageNo, fetcher, endDay);
      const signature = JSON.stringify(next.rows);
      if (next.total !== first.total || seenPages.has(signature))
        throw new CollectionError('공공 API 페이지가 반복되거나 전체 개수가 변경되었습니다.');
      seenPages.add(signature);
      rows.push(...next.rows);
    }
    if (
      rows.length !== first.total ||
      rows.length < definition.minimum ||
      new Set(rows.map((row) => row.asoStdCd)).size !== rows.length
    )
      throw new CollectionError('펀드 전체 목록이 불완전하거나 코드가 중복되었습니다.');
    const check = await page(definition, key, undefined, 1, fetcher, endDay);
    if (check.total !== first.total || JSON.stringify(check.rows) !== JSON.stringify(first.rows))
      throw new CollectionError('수집 도중 펀드 원본이 변경되었습니다.');
    const latest = rows.reduce((day, row) => (row.basDt > day ? row.basDt : day), '');
    return transformRows(kind, rows, latest, now.toISOString());
  }
  for (let offset = 1; offset <= lookback; offset++) {
    const day = new Date(Date.parse(`${koreanDay}T00:00:00Z`) - offset * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    const first = await page(definition, key, day, 1, fetcher);
    if (!first.total) continue; // Weekends, public holidays and delayed publications.
    const rows = [...first.rows];
    const seen = new Set([JSON.stringify(first.rows)]);
    for (let pageNo = 2; rows.length < first.total; pageNo++) {
      if (pageNo > 1000) throw new CollectionError('공공 API 페이지 한도 초과');
      const next = await page(definition, key, day, pageNo, fetcher);
      const signature = JSON.stringify(next.rows);
      if (next.total !== first.total || seen.has(signature))
        throw new CollectionError('공공 API 페이지가 반복되거나 전체 개수가 변경되었습니다.');
      seen.add(signature);
      rows.push(...next.rows);
    }
    if (rows.length !== first.total || rows.length < definition.minimum)
      throw new CollectionError('공공 목록이 불완전합니다.');
    return transformRows(kind, rows, day, now.toISOString());
  }
  throw new CollectionError('최근 14일의 원본 목록을 찾지 못했습니다.');
}

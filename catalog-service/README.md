# 공개 검색 목록 수집·배포

GitHub Actions가 금융위원회 공공 API를 하루 한 번 수집하고 Cloudflare Workers Static Assets에 JSON 파일을 배포합니다. 상시 실행 서버나 데이터베이스는 없습니다. 인증키는 수집 작업에서만 사용합니다. 앱은 공개 HTTPS 주소에서 파일을 받아 기기에 저장합니다.

현재는 **코드와 설정 준비 단계**입니다. GitHub 저장소·Cloudflare 계정·공공데이터 인증키를 등록하기 전에는 실제 공공 API 갱신이나 외부 배포가 실행되지 않습니다. 인증 없는 원본의 갱신 기능은 기존대로 작동합니다.

## 출처와 적용 범위

| 목록          | 현재 연결                                                                         | 중앙 배포                                         |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| 금융기관      | 배포 주소 설정 시 금융위원회 금융회사기본정보, 미설정 시 기존 포트원 목록         | 구현                                              |
| 일반 펀드     | 배포 주소 설정 시 금융위원회 펀드상품기본정보, 미설정 시 등록 항목 검색·직접 입력 | 구현                                              |
| 국내 주식·ETF | 앱에서 한국투자증권 종목 마스터 직접 다운로드                                     | 재배포 권리 확인 전 보류                          |
| 미국 주식·ETF | 앱에서 한국투자증권 종목 마스터 직접 다운로드                                     | 거래소 등 대체 출처의 범위·이용 조건 확인 전 보류 |
| 코인          | 앱에서 업비트 원화마켓 직접 조회                                                  | 재배포 권리 확인 전 보류                          |

검토한 공식 문서 (2026-11-09):

- [금융회사기본정보](https://www.data.go.kr/data/15043232/openapi.do): `getFnCoOutl`, `fncoNm` 사용. 이용허락범위 제한 없음.
- [펀드상품기본정보](https://www.data.go.kr/data/15094792/openapi.do): `getStandardCodeInfo`, `fndNm`, `asoStdCd`, `srtnCd` 사용. 이용허락범위 제한 없음.
- [금융위원회 갱신 안내](https://www.fsc.go.kr/in060501): 기준일 다음 영업일 13시 이후 제공. 포털의 요약 메타데이터에 있는 ‘실시간’ 대신 상세 설명을 기준으로 처리.
- [공공 KRX 종목](https://www.data.go.kr/data/15094775/openapi.do)과 [ETF API](https://www.data.go.kr/data/15094806/openapi.do)는 무단 제3자 제공·재배포 금지가 명시되어 있어 이 수집기에 포함하지 않음.

금융기관은 법인명 앞뒤의 `주식회사`·`(주)` 표기를 정리하고 일부 익숙한 표시명으로 매핑합니다. 우체국·상호금융 선택 항목은 앱 보완 목록이며 출처에 이를 표시합니다. API의 대표자명·주소·전화번호 등은 배포하지 않습니다. 등록된 계좌의 기관명은 바꾸지 않습니다.

펀드는 **협회표준코드**를 식별자로 사용합니다. 이름이 같아도 코드를 합치지 않고, 단축코드는 검색 별칭으로 둡니다. 이름에 붙은 A·C·온라인 등의 클래스를 유지합니다. API에는 통화 필드가 없으므로 목록 내부의 KRW는 검색용 기본값일 뿐 원본에서 확인한 통화가 아닙니다. 앱에서 공공 펀드를 선택할 때는 사용자가 현재 선택한 통화를 유지하고 확인 문구를 표시합니다. 평가금액·수량·거래 가능 여부는 이 목록에서 가져오지 않습니다.

## 처음 설정하는 순서

1. 공공데이터포털에서 위 **두 API 각각** 활용신청을 승인받습니다. `ServiceKey`/`serviceKey`를 동일 키로 사용할 수 있는지 승인 상태를 확인합니다. 이 수집기는 Encoding/Decoding 키 모두 받아 한 번만 URL 인코딩합니다.
2. 목록 수집용 GitHub 저장소를 만듭니다. 앱 소스를 공개하지 않아도 됩니다. 이 폴더 `catalog-service/`와 `.github/workflows/catalogs.yml`만 같은 위치로 복사하면 됩니다. 새 저장소 루트의 `.gitignore`에 `.env*`를 추가하여 로컬 인증키 파일을 제외합니다. 공개 저장소의 표준 Actions 실행 환경은 무료이며, 비공개 저장소는 계정의 무료 제공량을 사용합니다.
3. Cloudflare 계정에서 Workers용 API 토큰을 만듭니다. 해당 계정의 **Workers Scripts 편집** 권한을 부여하고 Account ID를 확인합니다. API 토큰·Account ID·공공 API 키는 앱에 넣지 않습니다.
4. GitHub 저장소 → Settings → Secrets and variables → Actions → **Secrets**에 다음 값을 등록합니다.

| Secret                   | 값                              |
| ------------------------ | ------------------------------- |
| `DATA_GO_KR_SERVICE_KEY` | 두 공공 API에 활용승인된 인증키 |
| `CLOUDFLARE_API_TOKEN`   | 배포 계정의 Workers 편집 토큰   |
| `CLOUDFLARE_ACCOUNT_ID`  | Cloudflare 계정 ID              |

5. `wrangler.jsonc`의 `name`을 원하는 프로젝트명으로 변경합니다. 기본값은 `moa-catalogs`입니다. Actions → **Publish public reference catalogs** → Run workflow에서 **bootstrap을 체크하여 최초 1회** 실행합니다. 저장소 기본 브랜치에 workflow가 있어야 합니다.
6. 배포 결과의 `https://프로젝트명.계정하위도메인.workers.dev` 주소에서 `manifest.json`을 확인합니다. 두 목록에 기준일·개수·파일명이 있어야 합니다. 실제 API 응답·완전성은 인증키 등록 후 이 단계에서 최종 확인합니다.
7. GitHub Actions **Variables**에 `CATALOG_BASE_URL`을 해당 주소로 등록합니다. 이후 bootstrap은 끕니다. 주소가 비어 있는 예약 실행은 이전 목록 유실 방지를 위해 중단됩니다. 기존 배포를 읽지 못한 경우에도 새 배포를 중단합니다.
8. 앱의 `.env.local`에 `EXPO_PUBLIC_CATALOG_URL=https://프로젝트명.계정하위도메인.workers.dev`를 추가하고 앱을 다시 빌드·배포합니다. Expo 환경변수는 빌드에 포함됩니다. **인증키는 EXPO_PUBLIC\_ 변수에 넣지 않습니다.**

원본 API를 사용할 수 없는 경우에는 기존 앱 빌드와 배포 주소를 유지합니다. 공공 목록 연결을 되돌리려면 앱의 `EXPO_PUBLIC_CATALOG_URL`을 비우고 재빌드합니다. 현재 기기에 저장된 목록은 삭제되지 않습니다.

## 갱신과 실패 처리

- 수집 예약: 매일 **한국시간 15:17** (`17 6 * * *` UTC). 예약 실행은 지연될 수 있습니다. 공개 저장소는 장기 비활동 시 예약 작업이 비활성화될 수 있으므로 Actions 실행 이력을 확인합니다.
- 기준일 탐색: 어제부터 최대 14일 전까지 조회하여 주말·공휴일·원본 지연을 처리합니다. 같은 기준일로 모든 페이지를 받습니다.
- 검증: 페이지 번호·전체 개수·기준일 일치, 반복 페이지, 필수 필드·중복 코드, 파일 크기, 이전보다 오래된 기준일, 항목 수 20% 초과 감소를 검사합니다.
- 목록 하나가 실패하면 해당 목록은 이전 배포를 유지하고, 성공한 목록만 반영합니다. 작업 마지막에 실패 목록을 표시하고 Actions를 실패로 처리해 운영자가 알 수 있게 합니다. 첫 실행에서 모든 목록이 실패하면 배포하지 않습니다.
- 내용과 원본 기준일이 그대로면 수집 시각만으로 파일을 새로 만들지 않습니다. `manifest.generatedAt`은 배포 생성 시각이고, 데이터의 `collectedAt`은 그 파일의 원본 수집 시각입니다.
- 앱은 한국시간 하루 첫 실행·복귀에 확인합니다. 목록별 수동 버튼도 있습니다. 수동 버튼은 **이미 배포된 최신 파일 확인**이며 원본 API의 강제 수집 명령이 아닙니다.
- 버전이 같으면 목록 본문을 다시 받지 않습니다. 기기에 저장한 시각과 원본 기준일은 별도 표시합니다. 원본 기준일 미제공 목록에는 이를 명시합니다.
- 대용량 목록은 기기에 압축·분할 저장하고, 모든 조각 저장 후 참조를 교체합니다. 오류·저장 공간 부족 시 이전 목록을 유지합니다. 계좌·자산·Google Drive 설정은 수정하지 않습니다.

## 파일 형식과 보안

`manifest.json`은 `version: 1`, `generatedAt`, `catalogs`를 갖습니다. 각 목록 항목은 `revision`(SHA-256), `file`, `count`, `asOf`를 담습니다. 파일명은 `fund-<SHA256>.json` 또는 `institutions-<SHA256>.json`입니다. 앱은 동일 HTTPS 출처의 정해진 파일명만 읽고, 해시·개수·기준일을 검증한 뒤 교체합니다.

JSON 본문은 `asOf`, `asOfKind: "source"`, `collectedAt`, `source`, `sourceUrl`, `items`, `groups`입니다. 최신·직전 버전 파일을 함께 배포하여 갱신 직전 manifest를 받은 앱도 다운로드할 수 있게 합니다. CORS는 공개 목록 조회용 `*`이며, 계좌·사용자 데이터나 인증키를 받는 API는 없습니다.

기존 목록이 정상인 상태에서 이름·코드 대량 변경 등으로 검증이 막히면 원본을 먼저 확인합니다. 검증을 자동 우회하거나 다른 출처로 몰래 교체하지 않습니다. 로그에 원본 응답·키가 포함된 요청 URL을 남기지 않습니다.

## 로컬 실행과 검증

수집기는 Node 24 내장 기능만 사용하며 앱 의존성 설치가 필요 없습니다. 프로젝트 루트에서 실행합니다.

```powershell
# 실제 값은 Git에서 제외된 .env.catalog.local에만 저장합니다.
# DATA_GO_KR_SERVICE_KEY=...
# CATALOG_BASE_URL=https://...
# 첫 배포를 준비하는 경우에만 CATALOG_BOOTSTRAP=1
node --env-file=.env.catalog.local catalog-service/publish.mjs
```

결과는 `catalog-service/public/`, 운영 보고서는 공개 폴더 밖의 `catalog-service/report.json`에 생성됩니다. 두 경로는 Git에서 제외됩니다. 임의 파일이 섞이지 않도록 이 public 폴더에는 수집기가 만든 파일만 둡니다.

앱 저장소에서는 `npm test`, `npm run lint`, `npm run typecheck`로 검증합니다. `tests/catalog-publish.test.ts`는 페이지·휴일·부분 실패·비밀키 보호를, `tests/catalog-hosted.test.ts`는 해시·버전·기준일 검증을, `tests/catalog-disk.test.ts`는 압축·분할 저장과 실패 시 보존을 검증합니다.

관련 운영 문서: [GitHub Actions 요금](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Cloudflare 정적 파일 요금](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [정적 파일 시작](https://developers.cloudflare.com/workers/static-assets/get-started/), [Expo 환경변수](https://docs.expo.dev/guides/environment-variables/).

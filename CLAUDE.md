# B-Talk 프로젝트 안내 (Claude용)

이 문서는 새 세션(다른 PC, 다른 앱, CLI 등)에서 작업을 시작하는 Claude가 프로젝트 맥락을 빠르게 파악하도록 정리한 문서입니다. 사용자는 개발자가 아니므로, 터미널 명령어나 git 조작을 사용자에게 시키지 말고 Claude가 직접 처리할 것.

## 서비스 개요

B-Talk는 익명 음성 채팅 웹앱.

- **프론트엔드**: `index.html` (저장소 루트, 약 7000줄). GitHub Pages로 실제 서비스 중 (`https://boundless-talk.github.io`). ⚠️ 저장소 안에 `B-Talk-main/index.html`이라는 오래된 중복 파일이 하나 더 있음 — 이건 실제 배포와 무관하니 편집하지 말 것. 항상 루트의 `index.html`을 편집.
- **인증/DB**: Firebase Auth (Google 로그인) + Firebase Realtime Database (`users`, `reports`, `appeals`, `channels` 등)
- **음성 통화**: Agora RTC SDK v4.18.0
- **관리자 패널**: `admin.html` (Firebase `reports` 참조)

## 배포 구조 (2026-07-18 기준)

세 갈래로 나뉘어 있음. 어떤 기능이 어디서 도는지 헷갈리기 쉬우니 주의.

1. **Render** — `server.js` (Express), `https://b-talk-0gi0.onrender.com`. 현재 대부분의 백엔드 기능이 여기 있음:
   - `/token` (Agora 토큰)
   - `/transcribe` (Whisper → gpt-4o-mini-transcribe)
   - `/translate` (DeepL)
   - `/summarize` (Gemini, 대화 요약)
   - `/getTopic` (Gemini — 현재 미사용, 주제 매칭은 로컬 `TOPIC_SYNONYM_MAP`으로만 동작)
   - `/reportUser` (Gemini 음성 신고 판정 + Firebase Storage — Netlify에서 이전했지만 실제 음성으로 end-to-end 테스트는 아직 안 됨)
   - `/push/notify` (FCM)
   - Gmail SMTP(nodemailer)는 Render에서 동작 안 함(아웃바운드 SMTP 포트 막힘 확인됨) — 이메일 발송은 반드시 HTTPS 기반(Resend, Brevo 등) 써야 함. Resend는 설정돼 있지만 도메인 미인증이라 계정 소유자 본인에게만 발송 가능한 상태.
2. **Netlify Functions** (`netlify/functions/`) — 현재 딱 두 개만 남음: `sendVerifyEmail.js` + `verifyEmailCode.js` (이메일 인증). 둘 다 버그 수정은 완료했지만 **Netlify 빌드가 "Stopped builds"로 막혀 있어서 git push해도 자동 배포 안 됨** — 배포하려면 Netlify 대시보드에서 수동 "Trigger deploy" 필요. 이유: 2026-07-17에 크레딧이 다 소진되는 사고가 있었고(불필요한 자동 빌드가 원인), `netlify.toml`의 ignore 설정 + Stopped builds로 막아둔 상태.
3. **Firebase 직접 쓰기** (서버리스 함수 없음) — `submitInquiry`, `submitRefund`, `submitAppeal`, `submitSuspendAppeal` 등은 프론트에서 Firebase DB에 바로 씀.

**주의**: git에 커밋됐다고 실제 서비스에 반영됐다고 가정하지 말 것. 특히 Netlify 쪽은 배포 여부를 Deploys 탭에서 직접 확인해야 함.

## Git / 배포 워크플로우

- 로컬 경로: `C:\Users\윤주황\Desktop\B-Talk-main`
- GitHub 저장소: `boundless-talk/boundless-talk.github.io`
- 로컬 브랜치 `master` → 원격 `main`. push 명령: `git push origin master:main`
- 사용자가 GitHub 웹 화면에서 직접 파일을 수정하는 경우가 있어 로컬이 뒤처질 수 있음. **push 전에 항상** `git fetch origin main` 후 `git log --oneline master..origin/main`으로 확인하고, 뒤처졌으면 `git merge origin/main --no-edit` 먼저 실행.
- 파일을 수정했으면 사용자가 요청하지 않아도 커밋 + push까지 자동으로 진행 (기존 합의된 워크플로우).

## 미해결/진행 중 작업

- 이메일 인증 기능(`sendVerifyEmail`/`verifyEmailCode`) — Netlify 수동 배포 필요, 아직 미완료
- `reportUser`(음성 신고 3진 아웃) — Render 이전 완료했지만 실제 음성으로 검증 안 됨
- Paddle 결제 연동 — KYB 승인 대기 중. 승인되면: 웹훅 연동(Paddle→Render→Firebase 구독 저장), 구독 관리 화면에 Paddle 고객 포털 연결, 환불 정책 문구 추가(첫 결제 후 7일 이내 환불), 결제 완료 알림에 환불 안내 추가, 프로덕션 Paddle 토큰/Price ID로 전환

## 커뮤니케이션 스타일

- 사용자는 비개발자. 기술 용어보다 결과 중심으로 설명할 것.
- 카피(문구) 작성 시 "무제한" 같은 모호한 표현 대신 정확한 메커니즘을 명시할 것 (예: "세션당 횟수 제한 없음"처럼 구체적으로).

## UI 작업 시 항상 지킬 것

- 새 UI 요소를 추가/수정할 땐 사용자가 매번 얘기하지 않아도 다크 모드(`data-cute-mode="dark"`, 블랙 배경 + 레드 `#e4362a` 포인트)와 라이트/큐트 모드(`data-cute-mode="cute"`, 크림 `#f7f4ee` 배경 + 마룬 `#8a2f2a` 포인트) 둘 다 톤앤매너를 맞출 것. `:root`의 기본 민트색(`--accent-color: #99E1D9`)은 실제로는 항상 위 두 값 중 하나로 덮어써지므로 실사용 화면에 노출되지 않음 — 새 요소를 목업/스크린샷으로 보여줄 때도 민트색이 아니라 실제 다크/라이트 값으로 확인할 것.
- 가능하면 기존 공유 클래스(`.settings-card`, `.settings-card-label`, `.settings-gear-btn`, `.nickname-modal-box`, `.nm-cancel-btn`, `.intro2-start-btn` 등)를 재사용해서 큐트 모드 대응을 자동으로 물려받을 것. 새 클래스/인라인 색상을 쓸 수밖에 없다면 `html[data-cute-mode="cute"] .클래스 {...}` 오버라이드를 같이 추가.

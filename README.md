# mydashboard

개인/회사 프로젝트 할일 체크리스트와 진척도 대시보드.

- **구조**: 대분류 → 프로젝트 → 단계 → 할일 (4단계)
- **호스팅**: GitHub Pages (Public 레포)
- **데이터**: 별도 Private Gist에 저장 (본인만 접근)
- **동기화**: 변경 즉시 Gist에 푸시, 5초마다 다른 기기 변경 폴링
- **기술**: 순수 HTML + CSS + Vanilla JS, 빌드 도구 없음

## 처음 설정하기

### 1) GitHub 레포 만들고 코드 푸시

이 폴더에서:

```powershell
git init
git add .
git commit -m "init dashboard"
git branch -M main
git remote add origin https://github.com/Han-Archi-git/mydashboard.git
git push -u origin main
```

### 2) GitHub Pages 활성화

레포 페이지 → **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` / `/ (root)` → Save.

1~2분 후 사이트 URL이 표시됨: `https://han-archi-git.github.io/mydashboard/`

### 3) Private Gist 만들기

https://gist.github.com/ 접속 → 파일명 `data.json`, 내용은 비워둬도 OK → 우측 `Create secret gist` 클릭.

만든 뒤 URL 끝부분이 Gist ID. 예: `https://gist.github.com/Han-Archi-git/abc123def456...` → `abc123def456...`가 ID.

### 4) Personal Access Token (PAT) 발급

https://github.com/settings/tokens?type=beta (Fine-grained tokens)

- **Token name**: mydashboard
- **Expiration**: 1년
- **Resource owner**: 본인
- **Repository access**: Public repositories 가능 (Gist는 별개)
- **Account permissions** → **Gists**: `Read and write`
- Generate token → 토큰 복사 (한 번만 표시됨)

### 5) 사이트 접속 + 연결

Pages URL을 PC/모바일 브라우저에서 열면 연결 모달이 뜸. PAT와 Gist ID 입력 → 저장.

이후 체크박스를 누를 때마다 Gist에 자동 저장되고, 다른 기기에서도 5초 이내에 반영됨.

## 데이터 구조

```json
{
  "version": 1,
  "updatedAt": "ISO 8601 시각",
  "categories": [
    {
      "id": "personal",
      "name": "개인",
      "color": "#6366f1",
      "projects": [
        {
          "id": "uuid",
          "name": "프로젝트명",
          "createdAt": "ISO",
          "phases": [
            {
              "id": "uuid",
              "name": "기획",
              "tasks": [
                { "id": "uuid", "title": "할일", "done": false, "memo": "", "due": null }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## 보안 노트

- 레포(`mydashboard`)는 **Public**이지만 데이터(`data.json`)는 **Private Gist**에 있으므로 외부에 노출되지 않음.
- PAT는 브라우저 LocalStorage에만 저장. 공용 PC에서는 사용 후 우측 상단 **설정 → 연결 해제** 권장.
- 토큰 유출 시: https://github.com/settings/tokens 에서 즉시 Revoke.

## 트러블슈팅

- **동기화 표시등(우상단 점)이 빨강**: PAT 만료/오타거나 Gist ID 오타. 설정 → 재연결.
- **다른 기기에 안 보임**: 5초 폴링 기다리거나 페이지 새로고침. 둘 다 같은 Gist를 가리키는지 확인.
- **충돌**: 두 기기에서 동시 수정 시 마지막 푸시가 이김. 동시 편집은 피할 것.

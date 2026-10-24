# editor-plugins

개발도구(에디터) 플러그인 모음. 에디터별 폴더로 나누고, 같은 목적의 기능은 플러그인 하나(**DevBoost**)에 모읍니다.

```
editor-plugins/
├─ vscode/
│  └─ devboost/             npm + TypeScript → .vsix
├─ intellij/
│  └─ devboost/             Gradle + Java/Kotlin → .zip   (예정)
└─ .github/workflows/
   ├─ vscode-release.yml    태그 vscode-v*   → .vsix Release
   └─ intellij-release.yml  태그 intellij-v* → .zip  Release
```

## 플러그인 목록

| 플러그인 | 에디터 | 기능 | 최신 버전 |
|---|---|---|---|
| [DevBoost](vscode/devboost) | VS Code | Search Everywhere | 0.2.0 |
| DevBoost | IntelliJ | (예정) | - |

## 설치

[Releases](../../releases)에서 받습니다.

- **VS Code**: `devboost-x.y.z.vsix` 다운로드 → 확장 탭 `...` → *VSIX에서 설치* (또는 `code --install-extension 파일명.vsix`)
- **IntelliJ**: `devboost-x.y.z.zip` 다운로드 → Settings → Plugins → ⚙ → *Install Plugin from Disk*

새 버전도 같은 방법으로 설치하면 덮어써집니다. (`.vsix`로 설치한 플러그인은 자동 업데이트되지 않습니다)

## 릴리스 규칙

1. 버전 올리기 — VS Code: `package.json`의 `version` / IntelliJ: `gradle.properties`의 `pluginVersion`
2. 해당 플러그인 폴더의 `CHANGELOG.md`에 `## x.y.z - YYYY-MM-DD` 섹션 추가
3. 커밋 후 태그 push
   ```bash
   git tag vscode-v0.2.0   && git push origin vscode-v0.2.0
   git tag intellij-v0.1.0 && git push origin intellij-v0.1.0
   ```
4. GitHub Actions가 빌드 → Release 생성 → 파일 첨부 → CHANGELOG 내용을 Release 설명으로 넣음

> 태그 버전과 파일 속 버전이 다르면 빌드가 실패합니다. Release는 손으로 만들지 않습니다.

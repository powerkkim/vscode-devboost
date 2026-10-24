# IntelliJ 플러그인 (예정)

`devboost/` 에 IntelliJ Platform Gradle Plugin 기반 프로젝트를 만들 예정입니다.

- 빌드: `./gradlew buildPlugin` → `build/distributions/*.zip`
- 디버그 실행: `./gradlew runIde` (플러그인이 설치된 IntelliJ 샌드박스가 뜸)
- 버전: `gradle.properties` 의 `pluginVersion`
- 릴리스 태그: `intellij-v<버전>`

참고: https://plugins.jetbrains.com/docs/intellij/

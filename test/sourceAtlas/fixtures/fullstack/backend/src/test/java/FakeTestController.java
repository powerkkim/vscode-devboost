// 테스트 소스는 분석에서 제외되어야 한다
@RestController @RequestMapping("/api/orders") class FakeTestController { @GetMapping("/test-only") void x() {} }

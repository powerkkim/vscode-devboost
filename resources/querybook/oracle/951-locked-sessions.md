---
title: 잠금을 걸고 있는 세션 찾기 (누가 막고 있나)
category: 세션·성능
db: oracle
tags: 락, LOCK, 잠금, 대기, 블로킹, V$SESSION, KILL SESSION, 멈춤
privilege: V$SESSION·V$SQL 조회 권한 (SELECT_CATALOG_ROLE 또는 DBA 에게 요청)
---
## 상황
UPDATE 가 끝나지 않고 계속 돈다. 누군가 같은 행을 고쳐 놓고 **커밋하지 않아서 기다리는 중**인 것 같다.
기다리는 세션과, 그 세션을 막고 있는 세션(누구, 어느 PC, 어느 프로그램)을 찾고 싶다.

## 예제 테이블
딕셔너리 뷰 `V$SESSION` 을 읽는다 (내 DB 에서 바로 실행, 권한 필요).
- `BLOCKING_SESSION` — 이 세션을 막고 있는 세션 번호 (없으면 NULL)

## 원하는 결과
| WAIT_SID | WAIT_USER | WAIT_SEC | BLOCK_SID | BLOCK_SERIAL | BLOCK_USER | BLOCK_MACHINE | BLOCK_PROGRAM | BLOCK_STATUS | WAIT_SQL |
|---:|---|---:|---:|---:|---|---|---|---|---|
| 512 | PLM_APP | 340 | 87 | 4411 | PLM_APP | DEV-PC01 | SQL Developer | INACTIVE | UPDATE TB_PART SET … |

## 쿼리
```sql
SELECT w.SID AS WAIT_SID,
       w.USERNAME AS WAIT_USER,
       w.SECONDS_IN_WAIT AS WAIT_SEC,
       b.SID AS BLOCK_SID,
       b.SERIAL# AS BLOCK_SERIAL,
       b.USERNAME AS BLOCK_USER,
       b.MACHINE AS BLOCK_MACHINE,
       b.PROGRAM AS BLOCK_PROGRAM,
       b.STATUS AS BLOCK_STATUS,
       (SELECT s.SQL_TEXT FROM V$SQL s WHERE s.SQL_ID = w.SQL_ID AND ROWNUM = 1) AS WAIT_SQL
  FROM V$SESSION w
  JOIN V$SESSION b ON b.SID = w.BLOCKING_SESSION
 WHERE w.BLOCKING_SESSION IS NOT NULL
 ORDER BY w.SECONDS_IN_WAIT DESC
```

## 풀이
- `w` = 기다리는 세션, `b` = 막고 있는 세션. `BLOCKING_SESSION` 으로 둘을 잇는다.
- `BLOCK_STATUS` 가 INACTIVE 면 막는 쪽은 아무것도 실행하지 않고 커밋·롤백만 안 한 상태다 (개발 도구에서 UPDATE 후 커밋을 잊은 경우가 대부분). 그 사람에게 커밋·롤백을 요청하는 것이 먼저다.
- 정말 끊어야 하면 DBA 가 `ALTER SYSTEM KILL SESSION '87,4411' IMMEDIATE` (BLOCK_SID, BLOCK_SERIAL). 끊긴 세션의 커밋 안 한 변경은 롤백된다.
- RAC(여러 노드) 환경이면 `V$SESSION` 대신 `GV$SESSION` 을 쓰고 `INST_ID` 도 함께 맞춘다.
- 이 콘솔도 자동 커밋을 하지 않는다. 내가 막고 있는 건 아닌지 도구 줄의 커밋 안 한 변경 수를 먼저 본다.
- **권한이 없을 때(ORA-00942)**: 누가 잠갔는지는 알 수 없지만, 그 행이 잠겨 있는지는 일반 사용자도 확인할 수 있다. `SELECT … FROM 테이블 WHERE 키 = … FOR UPDATE NOWAIT` — 바로 나오면 잠겨 있지 않고, ORA-00054 가 나면 다른 세션이 잡고 있다. 확인하면서 내가 그 행을 잠그므로 **바로 롤백**한다.

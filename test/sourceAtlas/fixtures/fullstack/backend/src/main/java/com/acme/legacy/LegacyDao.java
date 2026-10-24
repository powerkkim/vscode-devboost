package com.acme.legacy;

@Repository
public class LegacyDao {
    @Autowired
    private SqlSessionTemplate sqlSession;

    public int count() {
        return sqlSession.selectOne("com.acme.legacy.countAll");
    }
}

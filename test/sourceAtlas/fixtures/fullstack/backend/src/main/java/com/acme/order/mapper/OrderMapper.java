package com.acme.order.mapper;

@Mapper
public interface OrderMapper {
    List<OrderDto> selectOrders(String keyword);
    OrderDto selectOne(Long id);
    int insertOrder(OrderDto dto);
    int updateStatus(Long id, String status);
    int deleteOld();
}

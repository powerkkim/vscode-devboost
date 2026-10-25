package com.acme.order.service;

public interface OrderService {
    List<OrderDto> findAll();
    OrderDto findOne(Long id);
    void create(OrderDto dto);
}

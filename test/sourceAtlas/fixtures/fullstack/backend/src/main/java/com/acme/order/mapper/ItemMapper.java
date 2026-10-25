package com.acme.order.mapper;

@Mapper
public interface ItemMapper {
    @Select({"SELECT i.ID, i.NAME",
             " FROM ITEM i",
             " WHERE i.ID IN (SELECT ITEM_ID FROM ORDER_ITEM)"})
    List<ItemDto> findByIds(List<OrderDto> rows);
}

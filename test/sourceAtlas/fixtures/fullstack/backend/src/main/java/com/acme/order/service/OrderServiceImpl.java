package com.acme.order.service;

import com.acme.order.mapper.OrderMapper;
import com.acme.order.mapper.ItemMapper;

@Service
public class OrderServiceImpl implements OrderService {

    @Autowired
    private OrderMapper orderMapper;
    private final ItemMapper itemMapper;

    public OrderServiceImpl(ItemMapper itemMapper) {
        this.itemMapper = itemMapper;
    }

    @Override
    public List<OrderDto> findAll() {
        List<OrderDto> rows = orderMapper.selectOrders("x");
        enrich(rows);
        return rows;
    }

    private void enrich(List<OrderDto> rows) {
        itemMapper.findByIds(rows);
    }

    @Override
    public OrderDto findOne(Long id) {
        String note = "orderMapper.fake(" + id + ")";
        return orderMapper.selectOne(id);
    }

    @Override
    @Transactional
    public void create(OrderDto dto) {
        orderMapper.insertOrder(dto);
        orderMapper.updateStatus(dto.getId(), "NEW");
        orderMapper.deleteOld();
    }
}

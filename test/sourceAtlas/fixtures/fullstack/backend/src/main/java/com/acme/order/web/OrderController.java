package com.acme.order.web;

import com.acme.order.service.OrderService;
import com.acme.legacy.LegacyDao;
import org.springframework.web.bind.annotation.*;

/** 주문 API */
@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;
    private final LegacyDao legacyDao;

    @GetMapping
    public List<OrderDto> list() {
        return orderService.findAll();
    }

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable("id") Long id) {
        // orderService.ignoredInComment(id);
        return orderService.findOne(id);
    }

    @PostMapping(value = "/", produces = "application/json")
    public void create(@RequestBody OrderDto dto) {
        orderService.create(dto);
    }

    @RequestMapping(value = "/legacy-count", method = RequestMethod.GET)
    public int legacyCount() {
        return legacyDao.count();
    }
}

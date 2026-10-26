export const API = {
  ORDER: {
    LIST: '/orders',
    DETAIL: (id: number) => `/orders/${id}`,
    NESTED: { CANCEL: '/orders/cancel' },
  },
};
export const BASE = '/api';

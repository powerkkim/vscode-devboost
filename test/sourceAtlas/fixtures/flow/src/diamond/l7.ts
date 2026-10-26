import axios from 'axios';
export const s7a = () => axios.get('/api/deep/a');
export const s7b = () => axios.get('/api/deep/b');
export const s7c = () => axios.post('/api/deep/c');
export const s7d = () => axios.get('/api/deep/d');

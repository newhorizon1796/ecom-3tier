import axios from 'axios';

// In production this is left empty and Nginx proxies /api to the backend
// service (see nginx.conf). For local `npm start` dev, set
// REACT_APP_API_URL=http://localhost:5000 in a .env file.
const baseURL = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL,
  timeout: 8000,
});

export const getProducts = () => api.get('/api/products').then((r) => r.data);
export const createOrder = (items) => api.post('/api/orders', { items }).then((r) => r.data);

export default api;

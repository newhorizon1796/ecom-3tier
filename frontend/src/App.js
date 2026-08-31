import React, { useEffect, useState, useCallback } from 'react';
import { getProducts, createOrder } from './api';
import ProductList from './components/ProductList';
import Cart from './components/Cart';

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [error, setError] = useState(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [orderStatus, setOrderStatus] = useState(null);

  const loadProducts = useCallback(() => {
    getProducts()
      .then(setProducts)
      .catch(() => setError('Could not reach the backend API.'));
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const addToCart = (product) => setCart((c) => [...c, product]);

  const checkout = async () => {
    setCheckingOut(true);
    setOrderStatus(null);
    try {
      const order = await createOrder(cart.map((p) => p._id));
      setOrderStatus(`Order placed! ID: ${order._id}`);
      setCart([]);
    } catch {
      setOrderStatus('Checkout failed. Please try again.');
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>ShopEasy</h1>
      </header>
      {error && <p className="error">{error}</p>}
      <main>
        <ProductList products={products} onAdd={addToCart} />
        <Cart items={cart} onCheckout={checkout} checkingOut={checkingOut} orderStatus={orderStatus} />
      </main>
    </div>
  );
}

import React from 'react';

export default function Cart({ items, onCheckout, checkingOut, orderStatus }) {
  const total = items.reduce((sum, i) => sum + i.price, 0);

  return (
    <div className="cart">
      <h2>Cart ({items.length})</h2>
      <ul>
        {items.map((i, idx) => (
          <li key={idx}>
            {i.name} — ${i.price.toFixed(2)}
          </li>
        ))}
      </ul>
      <p className="total">Total: ${total.toFixed(2)}</p>
      <button disabled={!items.length || checkingOut} onClick={onCheckout}>
        {checkingOut ? 'Placing order…' : 'Checkout'}
      </button>
      {orderStatus && <p className="order-status">{orderStatus}</p>}
    </div>
  );
}

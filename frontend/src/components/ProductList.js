import React from 'react';

export default function ProductList({ products, onAdd }) {
  if (!products.length) {
    return <p>No products available.</p>;
  }

  return (
    <div className="product-grid">
      {products.map((p) => (
        <div className="product-card" key={p._id}>
          <h3>{p.name}</h3>
          <p className="price">${p.price.toFixed(2)}</p>
          <p className="desc">{p.description}</p>
          <button onClick={() => onAdd(p)}>Add to cart</button>
        </div>
      ))}
    </div>
  );
}

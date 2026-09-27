export function quote(subtotal) {
  if (typeof subtotal !== "number" || !Number.isFinite(subtotal) || subtotal <= 0 || subtotal > 10000) {
    return { error: "Subtotal must be a number greater than 0 and at most 10000" };
  }
  const shipping = subtotal > 100 ? 0 : 5;
  return { subtotal, shipping, total: Math.round((subtotal + shipping) * 100) / 100 };
}

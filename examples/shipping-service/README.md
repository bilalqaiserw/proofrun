# Shipping Service

A checkout application that gives shoppers a delivery quote before they pay.

No dependencies or build step. `npm start` starts the HTTP server on PORT (default 3100); `npm test` runs the checked-in unit tests. The homepage has a subtotal form and shows the shipping charge and total.

## Expected behavior

- GET /quote?subtotal=50 returns status 200 and {subtotal:50,shipping:5,total:55}.
- Orders below $100 pay $5 shipping. Orders of $100 or more receive free shipping, including exactly $100.
- A positive finite number up to 10000 is valid. Missing, blank, zero, negative, non-numeric and larger amounts return status 400 with an error object.
- Unknown routes return status 404. GET / returns the checkout form.

This is a small release candidate for demonstrating ProofRun. The existing unit tests cover ordinary/large orders and invalid values; practical testing should also check boundaries. It contains a deliberate shipping-boundary defect. No payment system or external service is involved.

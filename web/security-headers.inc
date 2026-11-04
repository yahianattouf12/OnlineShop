# Security headers for the frontend's own files (the API adds its own to API responses).
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
# Only our own scripts, styles, fonts and API; images also from blob: (upload preview) and data: (icons in CSS).
add_header Content-Security-Policy "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;

[out:json][timeout:120];
(
  relation["boundary"="administrative"]["admin_level"~"^(9|10|11)$"](18.99,72.81,19.14,72.91);
  way["boundary"="administrative"]["admin_level"~"^(9|10|11)$"](18.99,72.81,19.14,72.91);
);
out center tags;

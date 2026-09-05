[out:json][timeout:60];
(
  nwr["name"~"Khar Subway|Andheri Subway|Khodadad|Dadar TT|Tilak Bridge",i](19.00,72.82,19.13,72.87);
  way["tunnel"="yes"]["highway"~"primary|secondary|tertiary|residential|unclassified"](19.060,72.830,19.080,72.850);
  way["tunnel"="yes"]["highway"~"primary|secondary|tertiary|residential|unclassified"](19.110,72.835,19.130,72.856);
  nwr["name"~"Wadia",i]["amenity"](18.99,72.83,19.02,72.86);
  nwr["name"~"Pramod Mahajan|Kala Park|Kala Udyan|Holding Tank",i](18.99,72.82,19.03,72.86);
);
out center tags;

[out:json][timeout:120];
(
  nwr["amenity"="fire_station"](18.995,72.815,19.135,72.905);
  nwr["amenity"="hospital"](18.995,72.815,19.135,72.905);
  nwr["railway"="station"](18.995,72.815,19.135,72.905);
  nwr["railway"="halt"](18.995,72.815,19.135,72.905);
  nwr["man_made"="pumping_station"](18.995,72.815,19.135,72.905);
  nwr["name"~"Pumping Station",i](18.995,72.815,19.135,72.905);
  nwr["name"~"Hindmata|Bharatmata|Bharat Mata",i](18.995,72.815,19.135,72.905);
  nwr["tunnel"]["name"~"Subway",i](18.995,72.815,19.135,72.905);
  nwr["name"~"Ward Office|Municipal Office|BMC|Brihanmumbai|MCGM",i](18.995,72.815,19.135,72.905);
  nwr["office"="government"](18.995,72.815,19.135,72.905);
);
out center tags;

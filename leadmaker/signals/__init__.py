"""County-level regional signals: weather alerts, storm history and local news.

Signals are fetched once per county (not per lead) and stored in `regional_signals`;
leads join on `contractors.county_fips` at read time. Everything here is cheap and
rules-based -- nothing in this package calls an LLM.

  counties  ZIP -> 5-digit county FIPS (Census ZCTA relationship file)
  weather   NWS active alerts per county (api.weather.gov)
  storms    24-month storm history per county (NOAA NCEI Storm Events + NWS LSRs via IEM)
  store     small data-access helpers over `regional_signals`
  timing    pure rules: (lead, county signals, now) -> timing badges
"""

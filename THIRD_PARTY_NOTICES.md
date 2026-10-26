# Third-party notices

- [Leaflet](https://leafletjs.com), version 1.9.4, is vendored in `public/vendor/`. Its JavaScript, CSS and marker images are covered by the [BSD 2-Clause license](public/vendor/LEAFLET-LICENSE). The original file headers are preserved.
- [Express](https://expressjs.com/en/starter/installing/) and its dependencies are installed through npm. Their license files remain in the installed packages; exact versions are recorded in `package-lock.json`.
- The demo fixtures, property names and prices are synthetic. No property photography, copied reviews, browser profiles or travel-provider data is bundled. Screenshots show this app running locally with those fixtures. Demo review quotes, scores, review counts and climate figures are invented and are not copied provider content. Geographic basemaps are fetched live from the configured provider; Google attribution is retained in Google screenshots.

Optional online maps use OpenStreetMap tiles; Leaflet displays the map attribution. Provider terms and service policies apply when online mode is enabled.

- [Leaflet.GridLayer.GoogleMutant](https://www.npmjs.com/package/leaflet.gridlayer.googlemutant), version 0.16.0, is vendored for optional Google basemaps under its [Beerware license](public/vendor/GOOGLEMUTANT-LICENSE). Google Maps content is loaded at runtime, never bundled.

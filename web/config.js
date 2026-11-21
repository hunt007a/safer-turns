/* Safer Turns settings.
 * geoapifyKey: paste your Geoapify API key here to use Geoapify for address search.
 * Leave it empty to use Photon (komoot's free public server, light use only).
 * The key is visible to anyone who opens the site, so restrict it to your site's
 * address in the Geoapify dashboard before publishing.
 */
window.SAFER_TURNS_CONFIG = {
  geoapifyKey: "",
  roadsUrl: "roads/toronto.json",
  // south, west, north, east: address search is limited to this box
  searchBox: [43.581, -79.639, 43.856, -79.115],
};

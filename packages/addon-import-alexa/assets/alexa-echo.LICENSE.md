The Alexa mark in `alexa-echo.svg` is the `amazonalexa` icon from the
simple-icons project (https://simpleicons.org, package `simple-icons` 13.0.0),
released under CC0 1.0 Universal (public domain dedication).

One change: `fill="#00CAFF"` was added to the root element, the brand colour
simple-icons lists for it, so the mark reads on the dark and the light admin
theme in a bare `<img>`.

The mark itself remains a trademark of its owner. It is shown only to identify
the Alexa notification target.

`src/speak/icon-routes.ts` embeds the same bytes (the addon bundle carries no
asset directory); `src/__tests__/speak-icon.spec.ts` fails if the two differ.

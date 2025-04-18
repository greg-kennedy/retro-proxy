require("dotenv").config();
const fs = require("fs");
const fetch = require("node-fetch");
const express = require("express");
const cheerio = require("cheerio");
const minify = require("html-minifier").minify;
const CleanCSS = require("clean-css");
const Jimp = require("jimp");
const { URL } = require("url");

const app = express();

const ip = process.env.IP;
const port = process.env.PORT || 3000;
const stripCSS = process.env.NO_CSS;
const stripJs = process.env.NO_JS;
const blockCookies = process.env.NO_COOKIES;
const minifyImages = Boolean(process.env.RESIZE_TO);
let friendlies = [];
try {
  const input = fs.readFileSync(process.env.ALLOWLIST, { encoding: "utf-8" });
  friendlies = input.trim().split("\n");
  console.log("allow-list", friendlies);
} catch (error) {
  console.error('Failed to open "allowed.txt"! See allowed.txt.example for a starting point.');
  friendlies = [];
}
let forceSecureHosts = [];
const maxSrcWidth = process.env.RESIZE_TO;
const maxInlineWidth = process.env.SCALE_TO;
const headersToForward = [ 'Accept-Language', 'User-Agent', 'Content-Type' ]; // Referer, Origin and Cookie handled separately (below)

const cssMinifyOptions = {
  compatibility: {
    colors: {
      opacity: false, // controls `rgba()` / `hsla()` color support
    },
    properties: {
      backgroundClipMerging: false, // controls background-clip merging into shorthand
      backgroundOriginMerging: false, // controls background-origin merging into shorthand
      backgroundSizeMerging: false, // controls background-size merging into shorthand
      colors: true, // controls color optimizations
      ieBangHack: true, // controls keeping IE bang hack
      ieFilters: true, // controls keeping IE `filter` / `-ms-filter`
      iePrefixHack: true, // controls keeping IE prefix hack
      ieSuffixHack: true, // controls keeping IE suffix hack
      merging: false, // controls property merging based on understandability
      shorterLengthUnits: false, // controls shortening pixel units into `pc`, `pt`, or `in` units
      spaceAfterClosingBrace: true, // controls keeping space after closing brace - `url() no-repeat` into `url()no-repeat`
      urlQuotes: true, // controls keeping quoting inside `url()`
      zeroUnits: true, // controls removal of units `0` value
    },
    selectors: {
      adjacentSpace: false, // controls extra space before `nav` element
      ie7Hack: false, // controls removal of IE7 selector hacks, e.g. `*+html...`
      mergeLimit: 8191, // controls maximum number of selectors in a single rule (since 4.1.0)
      multiplePseudoMerging: true, // controls merging of rules with multiple pseudo classes / elements (since 4.1.0)
    },
    units: {
      ch: false, // controls treating `ch` as a supported unit
      in: false, // controls treating `in` as a supported unit
      pc: false, // controls treating `pc` as a supported unit
      pt: false, // controls treating `pt` as a supported unit
      rem: false, // controls treating `rem` as a supported unit
      vh: false, // controls treating `vh` as a supported unit
      vm: false, // controls treating `vm` as a supported unit
      vmax: false, // controls treating `vmax` as a supported unit
      vmin: false, // controls treating `vmin` as a supported unit
    },
  },
};

const minifyOptions = {
  collapseBooleanAttributes: true,
  collapseWhitespace: true,
  processConditionalComments: true,
  removeComments: true,
  minifyCSS: stripCSS ? false : cssMinifyOptions,
  continueOnParseError: true
};

app.use(express.raw( {type: '*/*'} ));

app.all("*", async (req, res, next) => {
  const friendly = friendlies.some((f) => req.hostname.endsWith(f));
  const url = req.originalUrl;
  if (friendly) {
    console.log("friendly site:", req.method, url);
  } else {
    console.log("hostile site:", req.method, url);
  }
  // modify the incoming URL based on whether the site is forcing HTTPS
  const forceSecure = forceSecureHosts.some((f) => req.hostname.endsWith(f));
  let upstreamUrl = url;
  if (forceSecure) {
    upstreamUrl = url.replace(/^http:/, "https:");
  }

  // retrieve headers from the client, if set
  let headers = {};
  headersToForward.forEach( (name) => {
    if (req.get(name)) {
      headers[name] = req.get(name);
    }
  } );
  // fix Referer if forceSecure from the prev. site
  let referer = req.get('Referer');
  if (referer) {
    let refUrl = new URL(referer);
    if (forceSecureHosts.some((f) => refUrl.hostname.endsWith(f))) {
      refUrl.protocol = 'https';
    }
    headers['Referer'] = refUrl.href;
    headers['Origin'] = refUrl.origin;
  }

  // only pass Cookie if allowed by .env
  if (! blockCookies) {
    let cookie = req.get('Cookie');
    if (cookie) {
      // all Cookies should be URL-encoded
      const cookieList = cookie.split(/\s*;\s*/);
      headers['Cookie'] = cookieList.map((ck) => {
        const index = ck.indexOf("=");
        if (index === -1) {
          return ck;
        } else {
          return ck.substring(0, index) + '=' + encodeURIComponent(ck.substring(index + 1));
        }
      }).join('; ');
    }
  }

  try {
    let options = {method: req.method, headers: headers, redirect: 'manual'};
    if (req.method != 'GET' && req.method != 'HEAD') {
      options['body'] = req.body;
    }
    const upstream = await fetch(upstreamUrl, options);

    // copy set-cookie header
    //  strip out any "secure" option, because the client is always http
    if (! blockCookies) {
      const setCookie = upstream.headers.raw()["set-cookie"]
      if (setCookie) {
        const fixedCookie = setCookie.map((cookie) => cookie.replace(/;\s*secure\s*/i, ""));
        res.set('Set-Cookie', fixedCookie);
      }
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const newUrl = upstream.headers.get('location');
      console.log("redirect (", upstream.status, ") ", url, " => ", newUrl);

      // try to figure out if the upstream is forcing us to use HTTPS only
      //  we test this by seeing if the request and location are the same,
      //  except the proto
      if (!forceSecure && newUrl == url.replace(/^http:/, "https:")) {
        forceSecureHosts.push(req.hostname);
        console.log(" . Forcing HTTPS for hostname", req.hostname);
      }

      // always return HTTP instead of HTTPS to the client though
      res.set("Location", newUrl.replace(/^https:/, "http:"));
      res.status(upstream.status);
      res.send(await upstream.buffer());
    } else {
      const contentType = upstream.headers.get("content-type");
      //console.log(contentType);
      if (contentType.startsWith("text/html")) {
        const imageSizes = {};
        const text = (await upstream.text()).replace(/https:\/\//g, "http://");
        const $ = cheerio.load(text);
        if (!friendly && stripJs) {
          $("script").remove();
          $("noscript").after(function (index) {
            $(this).contents();
          });
          $("noscript").remove();
        }
        if (!friendly && stripCSS) {
          $("style").remove();
          $("link").remove();
          $("*").removeAttr("class");
          $("*").removeAttr("style");
        }
        if (!friendly) {
          const imgs = [];
          $("img").each(function () {
            const src = new URL($(this).attr("src"), url).href;
            //remove SVGs for now
            if (src.toLowerCase().endsWith(".svg")) {
              $(this).remove();
            } else {
              imgs.push(this);
            }
          });
          //remove inline SVG as well
          $("svg").remove();

          if (maxInlineWidth) {
            //set image tag sizes
            for (let img of imgs) {
              const src = new URL($(img).attr("src"), url).href;
              const attrWidth = $(img).attr("width");
              const attrHeight = $(img).attr("height");
              if (!attrWidth) {
                try {
                  if (!imageSizes[src]) {
                    const image = await Jimp.read(src);
                    imageSizes[src] = {
                      width: image.bitmap.width,
                      height: image.bitmap.height,
                    };
                  }
                  const width = Math.min(maxInlineWidth, imageSizes[src].width);
                  const height =
                    (imageSizes[src].height * width) / imageSizes[src].width;
                  $(this).attr("width", width);
                    $(this).attr("height", height);
                } catch (error) {
                  console.error("Unable to resize image: "+error);
                }
              } else {
                const width = Math.min(maxInlineWidth, attrWidth);
                const height = (attrHeight * width) / attrWidth;
                $(this).attr("width", width);
                $(this).attr("height", height);
              }
            }
          }
        }
        //fix root-relative URLs for Netscape
        $("[href^='/']").each(function(index,element) {
          const href = $(element).attr('href');
          $(this).attr('href',new URL(url).origin+href);
        });
        // HACK to fix oauth - redirect_uri in a form field must be https
        $("input").each(function(index,element) {
          if ($(element).attr('id') === 'redirect_uri') {
            let redirect_uri = new URL($(element).attr('value'));
            if (forceSecureHosts.some((f) => redirect_uri.hostname.endsWith(f))) {
              redirect_uri.protocol = 'https';
              $(this).attr('value', redirect_uri.href);
            }
          }
        });

        res.set("Content-Type", "text/html");
        res.status(upstream.status);
        if (!friendly) {
          const minified = minify(
            $.root()
              .html()
              .replace(/&apos;/g, "'"),
            minifyOptions
          );
          console.log("html minified", upstream.status, contentType, url);
          res.send(minified);
        } else {
          res.send(
            $.root()
              .html()
              .replace(/&apos;/g, "'")
          );
        }
      } else if (contentType.startsWith("text/css")) {
        const text = await upstream.text();
        res.set("Content-Type", "text/css");
        res.status(upstream.status);
        res.send(new CleanCSS(cssMinifyOptions).minify(text).styles);
        console.log("css minified", contentType, url);
      } else if (
        !friendly &&
        minifyImages &&
        contentType.startsWith("image/") &&
        !contentType.includes("xml")
      ) {
        const buffer = await upstream.buffer();
        const image = await Jimp.read(buffer);
        image.resize(Math.min(maxSrcWidth, image.bitmap.width), Jimp.AUTO);
        image.quality(50);
        const output = await image.getBufferAsync("image/jpeg");
        res.set("Content-Type", "image/jpeg");
        res.status(upstream.status);
        res.send(output);
        console.log("image minified", contentType, url);
      } else {
        res.set("Content-Type", contentType);
        res.status(upstream.status);
        res.send(await upstream.buffer());
      }
    }
  } catch (error) {
    console.error(error);
    res.set("Content-Type", "text/html");
    res.status(502);
    res.send(
      `<html>
  <head>
    <title>502 - Bad Gateway</title>
  </head>
  <body>
    <h1>502 - Bad Gateway</h1>
    <p>An error occurred while retrieving the page. Please check the server log for details.
  </body>
</html>`
    );
  }
});

if (ip != "") {
  app.listen(port, ip);
} else {
  app.listen(port);
}
console.log(
  `Listening on port ${port}, CSS is ${
    stripCSS ? "disabled" : "enabled"
  }, images are ${minifyImages ? "compressed" : "original quality"}, cookies are ${blockCookies ? "blocked" : "allowed"}`
);

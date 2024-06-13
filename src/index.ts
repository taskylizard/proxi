class TextRewriter {
  constructor(private rewriter: (text: string) => string, private buffer: string = "") { }

  text(text: Text): void {
    this.buffer += text.text;

    if (text.lastInTextNode) {
      text.replace(this.rewriter(this.buffer), { html: true });
      this.buffer = "";
    } else {
      text.remove();
    }
  }
}

class AttributeRewriter {
  private attribute: string;
  private proxy: URL;
  private upstream: URL;

  constructor(attribute: string, proxy: URL, upstream: URL) {
    this.attribute = attribute;
    this.proxy = proxy;
    this.upstream = upstream;
  }
  element(element: Element) {
    let attribute = element.getAttribute(this.attribute);
    if (attribute) {
      if (!attribute.match(/^[\w-]+:\/\/.*/) && !attribute.match(/^data:.*/)) {
        attribute = new URL(attribute, this.upstream.origin).href;
      }
      element.setAttribute(
        this.attribute,
        attribute.replace(/^(https?:\/\/.*)/, `${this.proxy.origin}/$1`),
      );
    }
  }
}

function rewrite(originURL: URL, publicURL: URL) {
  return (text: string | null): string => {
    if (text == null) return "";

    const originURLHostPort = originURL.port
      ? `${originURL.hostname}:${originURL.port}`
      : originURL.hostname;
    const publicURLHostPort = publicURL.port
      ? `${publicURL.hostname}:${publicURL.port}`
      : publicURL.hostname;

    return (
      text
        // Relative URLs
        .replaceAll("'/", `'${publicURL.origin}/`)
        .replaceAll('"/', `"${publicURL.origin}/`)
        .replaceAll("</", `<${publicURL.origin}/`)
        // URLs with escaped "/" in JavaScript/JSON
        .replaceAll(
          `${originURL.origin.replaceAll("/", "\\/")}`,
          `${publicURL.origin.replaceAll("/", "\\/")}${publicURL.pathname.replaceAll("/", "\\/")}`,
        )
        // Full URL
        .replaceAll(originURL.origin, publicURL.origin)
        // URL with // instead of full protocol https://
        .replaceAll(
          `//${originURLHostPort}${originURL.pathname}`,
          `//${publicURLHostPort}${publicURL.pathname}/`,
        )
        // Hostname and port
        .replaceAll(originURL.hostname, publicURLHostPort)
    );
  };
}

async function proxy(request: Request, upstreamURL: URL): Promise<Response> {
  const proxyURL = new URL(request.url);
  let proxyHeaders = new Headers(request.headers);
  proxyHeaders.set("Host", upstreamURL.origin);
  proxyHeaders.set("Referer", proxyURL.origin);

  let upstreamResponse = await fetch(upstreamURL.href, {
    method: request.method,
    headers: proxyHeaders,
  });

  // Modifiying response headers
  let responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("access-control-allow-credentials", "true");
  responseHeaders.delete("content-security-policy");
  responseHeaders.delete("content-security-policy-report-only");
  responseHeaders.delete("clear-site-data");
  responseHeaders.set("X-Forwarded-Host", proxyURL.origin);
  responseHeaders.set("X-Forwarded-Proto", proxyURL.protocol);
  responseHeaders.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") || "");
  const contentType = responseHeaders.get("content-type");
  const rewriteURLs = rewrite(proxyURL, upstreamURL);

  // Rewrite link header (preloads)
  if (responseHeaders.has("link"))
    responseHeaders.set("link", rewriteURLs(responseHeaders.get("link")));
  if (contentType?.includes("text/html")) {
    const rewriter = new HTMLRewriter()
      .on("form", new AttributeRewriter("action", proxyURL, upstreamURL))
      .on("img", new AttributeRewriter("src", proxyURL, upstreamURL))
      .on("img", new AttributeRewriter("srcset", proxyURL, upstreamURL))
      .on("link", new AttributeRewriter("href", proxyURL, upstreamURL))
      .on("a", new AttributeRewriter("href", proxyURL, upstreamURL))
      .on("script", new AttributeRewriter("src", proxyURL, upstreamURL))
      .on("script", new TextRewriter(rewriteURLs))
      .on("style", new TextRewriter(rewriteURLs));

    let isHtml = String(responseHeaders.get("content-type")).includes("text/html");
    let responseBody = isHtml ? rewriter.transform(upstreamResponse).body : upstreamResponse.body;
    let responseStatus = upstreamResponse.status;

    return new Response(responseBody, {
      status: responseStatus,
      headers: responseHeaders,
    });
  } else if (
    contentType?.startsWith("text/") ||
    contentType?.startsWith("application/x-javascript") ||
    contentType?.startsWith("application/javascript")
  ) {
    // Rewrite text files (CSS, JavaScript)
    const body = await upstreamResponse.text();
    const body_ = rewriteURLs(body);
    return new Response(body_, upstreamResponse);
  } else {
    // Can't and won't do anything with this content
    return upstreamResponse;
  }
}

export default {
  async fetch(request: Request) {
    const proxyURL = new URL(request.url);
    const path = proxyURL.href.substr(proxyURL.origin.length);

    // Redirect http to https
    if (proxyURL.protocol === "http:") {
      proxyURL.protocol = "https:";
      const headers: Record<string, string> = {
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        location: proxyURL.href,
      };
      return new Response("http not allowed", {
        status: 301,
        headers: headers,
      });
    }

    // Fetch resources
    const matchArray = path.match(/\/(https?:)\/+(.*)/);
    const upstream = matchArray ? `${matchArray[1]}//${matchArray[2]}` : "";

    try {
      const upstreamURL = new URL(upstream);
      return proxy(request, upstreamURL);
    } catch (error) {
      return new Response("What is that URL?", { status: 400 });
    }
  },
};

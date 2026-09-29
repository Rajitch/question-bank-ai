const MODEL_ID = "onnx-community/Llama-3.2-1B-Instruct-q4f16";
const MODEL_PREFIX = `/hf-model/${MODEL_ID}/`;
const HF_ORIGIN = "https://huggingface.co";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Content-Type,If-Range,If-None-Match,If-Modified-Since",
    "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range,ETag,Last-Modified",
    "Vary": "Origin",
  };
}

async function proxyModel(request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("Origin")) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders(request.headers.get("Origin")) });
  }
  if (!url.pathname.startsWith(MODEL_PREFIX)) {
    return new Response("Not found", { status: 404 });
  }

  const upstreamPath = url.pathname.slice("/hf-model/".length);
  const upstreamURL = `${HF_ORIGIN}/${upstreamPath}${url.search}`;

  // Forward only headers useful for large/ranged model downloads. Do not forward
  // the browser Origin header to Hugging Face.
  const headers = new Headers();
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since", "accept", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(upstreamURL, {
    method: request.method,
    headers,
    redirect: "follow",
  });

  const out = new Headers(upstream.headers);
  for (const [name, value] of Object.entries(corsHeaders(request.headers.get("Origin")))) out.set(name, value);
  out.set("Cache-Control", "public, max-age=31536000, immutable");
  out.delete("Set-Cookie");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/hf-model/")) {
      try {
        return await proxyModel(request);
      } catch (error) {
        return new Response(`Model proxy error: ${error?.message || String(error)}`, {
          status: 502,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...corsHeaders(request.headers.get("Origin")),
          },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};

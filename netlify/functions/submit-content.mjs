export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        status: 'error',
        saved: false,
        message: 'Method not allowed.'
      }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  }

  const googleAppsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;

  if (!googleAppsScriptUrl) {
    return new Response(
      JSON.stringify({
        status: 'error',
        saved: false,
        message: 'Missing GOOGLE_APPS_SCRIPT_URL environment variable.'
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  }

  let rawBody = '';

  try {
    rawBody = await req.text();
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        saved: false,
        message: 'Request body is unreadable.'
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  }

  const formData = new URLSearchParams();

  if (rawBody) {
    const params = new URLSearchParams(rawBody);
    for (const [key, value] of params.entries()) {
      if (key && value !== undefined && value !== null) {
        formData.append(key, value);
      }
    }
  }

  const controller = new AbortController();
  const timeoutMs = 25000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(googleAppsScriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json, text/plain, */*'
      },
      body: formData.toString(),
      signal: controller.signal
    });

    const responseText = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      parsed = null;
    }

    const verifiedSuccess = Boolean(
      response.ok &&
      parsed &&
      parsed.status === 'success' &&
      parsed.saved === true
    );

    if (!verifiedSuccess) {
      return new Response(
        JSON.stringify({
          status: 'error',
          saved: false,
          message: 'Google Apps Script did not confirm saved: true after writing to the sheet.',
          rawResponse: parsed ?? responseText
        }),
        {
          status: response.ok ? 502 : response.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json; charset=utf-8'
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        saved: true,
        message: parsed.message || 'Data berhasil dikonfirmasi oleh server.',
        data: parsed
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  } catch (error) {
    const isTimeout = error && typeof error.name === 'string' && error.name === 'AbortError';

    return new Response(
      JSON.stringify({
        status: 'error',
        saved: false,
        message: isTimeout
          ? 'Timeout while contacting Google Apps Script.'
          : 'Unable to reach Google Apps Script.'
      }),
      {
        status: isTimeout ? 504 : 502,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

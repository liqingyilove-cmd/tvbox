export async function onRequest(context) {
    return new Response("OK - Worker is running!", {
        headers: { "Content-Type": "text/plain" }
    });
}

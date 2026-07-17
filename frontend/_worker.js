export async function onRequest(context) {
    return new Response("Hello from TVBox aggregator! Worker is alive.", {
        headers: { "Content-Type": "text/plain;charset=UTF-8" }
    });
}

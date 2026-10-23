// Importing missing.c has to fail with an error this code can catch, not kill node at the first call.
try {
  const { api } = await import("./missing.c");
  console.log(JSON.stringify({ result: api(1) }));
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message }));
}

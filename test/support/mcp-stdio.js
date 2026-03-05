export function encodeMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export function decodeFrames(buffer) {
  const messages = [];
  let remainder = buffer.toString("utf8");

  while (true) {
    const newlineIndex = remainder.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = remainder.slice(0, newlineIndex).replace(/\r$/, "");
    remainder = remainder.slice(newlineIndex + 1);
    if (line) {
      messages.push(JSON.parse(line));
    }
  }

  return {
    messages,
    remaining: Buffer.from(remainder, "utf8"),
  };
}

export async function sendRequest(server, request, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let responseBuffer = Buffer.alloc(0);

    const timeout = setTimeout(() => {
      server.stdout.off("data", onData);
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(data) {
      responseBuffer = Buffer.concat([responseBuffer, data]);
      const { messages, remaining } = decodeFrames(responseBuffer);
      responseBuffer = remaining;

      const match = messages.find((message) => message.id === request.id);
      if (match) {
        clearTimeout(timeout);
        server.stdout.off("data", onData);
        resolve(match);
      }
    }

    server.stdout.on("data", onData);
    server.stdin.write(encodeMessage(request));
  });
}

export function sendNotification(server, notification) {
  server.stdin.write(encodeMessage(notification));
}

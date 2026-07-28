"use client";

import { useState, useRef, useEffect } from "react";

type ChatMessage = {
  role: "user" | "model";
  text: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", text }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Something went wrong.");
      }

      setMessages((prev) => [...prev, { role: "model", text: data.text }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-2xl flex-col px-4 py-8">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50 mb-4">
          Customer Engagement Assistant
        </h1>

        <div className="flex-1 flex flex-col gap-3 overflow-y-auto rounded-lg border border-black/[.08] dark:border-white/[.145] bg-white dark:bg-zinc-950 p-4 min-h-[400px]">
          {messages.length === 0 && (
            <p className="text-zinc-500 dark:text-zinc-400 text-sm">
              Ask a question to get started.
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "self-end bg-black text-white dark:bg-zinc-50 dark:text-black"
                  : "self-start bg-zinc-100 text-black dark:bg-zinc-800 dark:text-zinc-50"
              }`}
            >
              {m.text}
            </div>
          ))}
          {loading && (
            <div className="self-start rounded-2xl bg-zinc-100 px-4 py-2 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Thinking...
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="mt-4 flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-lg border border-black/[.08] dark:border-white/[.145] bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-black dark:text-zinc-50 focus:outline-none"
            rows={2}
            placeholder="Type your message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#383838] disabled:opacity-40 dark:bg-zinc-50 dark:text-black dark:hover:bg-[#ccc]"
          >
            Send
          </button>
        </div>
      </main>
    </div>
  );
}

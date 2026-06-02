'use client'

export default function FBAListingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <h2 className="text-xl font-bold text-red-600 mb-4">Something went wrong!</h2>
      <pre className="bg-gray-100 p-4 rounded text-sm overflow-auto mb-4 whitespace-pre-wrap">
        {error.message}
        {error.digest && `\nDigest: ${error.digest}`}
        {error.stack && `\n\nStack:\n${error.stack}`}
      </pre>
      <button
        onClick={reset}
        className="px-4 py-2 bg-violet-600 text-white rounded hover:bg-violet-700"
      >
        Try again
      </button>
    </div>
  )
}

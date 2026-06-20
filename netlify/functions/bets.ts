import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'
import { verifyMessage } from 'viem'

const jsonHeaders = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

type StoredBets = {
  bets: unknown[]
  updatedAt: string
  wallet: string
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: jsonHeaders, status: 204 })
  }

  const wallet = normalizeWallet(new URL(req.url).searchParams.get('wallet') ?? context.params.wallet)
  if (!wallet) {
    return json({ error: 'Valid wallet address required' }, 400)
  }

  const authorized = await isAuthorized(req, wallet)
  if (!authorized) {
    return json({ error: 'Wallet signature required' }, 401)
  }

  const store = getStore({ consistency: 'strong', name: 'akibabet-bets' })
  const key = `wallet/${wallet}.json`

  if (req.method === 'GET') {
    const stored = await store.get(key, { type: 'json' }) as StoredBets | null
    return json(stored ?? { bets: [], updatedAt: null, wallet })
  }

  if (req.method === 'PUT') {
    const body = await req.json() as { bets?: unknown[] }
    const bets = Array.isArray(body.bets) ? body.bets.slice(0, 200) : []
    const payload: StoredBets = {
      bets,
      updatedAt: new Date().toISOString(),
      wallet,
    }

    await store.setJSON(key, payload)
    return json(payload)
  }

  return json({ error: 'Method not allowed' }, 405)
}

export const config: Config = {
  method: ['GET', 'PUT', 'OPTIONS'],
  path: '/api/bets',
}

function normalizeWallet(value: string) {
  const wallet = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(wallet) ? wallet : ''
}

async function isAuthorized(req: Request, wallet: string) {
  const signature = req.headers.get('x-akibabet-signature')
  if (!signature || !signature.startsWith('0x')) {
    return false
  }

  try {
    return await verifyMessage({
      address: wallet as `0x${string}`,
      message: getHistorySyncMessage(wallet),
      signature: signature as `0x${string}`,
    })
  } catch {
    return false
  }
}

function getHistorySyncMessage(wallet: string) {
  return `AkibaBet history sync\nWallet: ${wallet.toLowerCase()}`
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: jsonHeaders,
    status,
  })
}

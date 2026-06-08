import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Coins,
  Copy,
  ExternalLink,
  Landmark,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TrendingDown,
  Wallet,
} from 'lucide-react'
import { createPublicClient, createWalletClient, custom, erc20Abi, formatEther, formatUnits, http, parseUnits } from 'viem'
import type { Address } from 'viem'
import { celo, celoSepolia } from 'viem/chains'
import './App.css'

const CELO_MAINNET_USDT_ADDRESS = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const CELO_SEPOLIA_USDC_ADDRESS = '0x01c5c0122039549ad1493b8220cabedd739bc44e'
const STABLE_TOKEN_DECIMALS = Number(import.meta.env.VITE_STABLE_TOKEN_DECIMALS ?? 6)
const CELO_NETWORK = import.meta.env.VITE_CELO_NETWORK === 'sepolia' ? 'sepolia' : 'mainnet'
const ACTIVE_CHAIN = CELO_NETWORK === 'sepolia' ? celoSepolia : celo
const DEFAULT_STABLE_TOKEN_SYMBOL = CELO_NETWORK === 'sepolia' ? 'USDC' : 'USDT'
const DEFAULT_STABLE_TOKEN_ADDRESS = CELO_NETWORK === 'sepolia' ? CELO_SEPOLIA_USDC_ADDRESS : CELO_MAINNET_USDT_ADDRESS
const STABLE_TOKEN_SYMBOL = import.meta.env.VITE_STABLE_TOKEN_SYMBOL ?? DEFAULT_STABLE_TOKEN_SYMBOL
const STABLE_TOKEN_ADDRESS = (import.meta.env.VITE_STABLE_TOKEN_ADDRESS ?? DEFAULT_STABLE_TOKEN_ADDRESS) as Address
const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS as Address | undefined
const CELO_SEPOLIA_FAUCET_URL = 'https://faucet.celo.org/celo-sepolia'
const CIRCLE_FAUCET_URL = 'https://faucet.circle.com/?allow=true'

type BetStatus = 'pending' | 'won' | 'lost'

type BetLeg = {
  id: number
  fixture: string
  odds: number
}

type BetSlip = {
  id: number
  createdAt: number
  settledAt?: number
  legs: BetLeg[]
  platform: string
  stake: number
  status: BetStatus
}

type VaultAction = 'deposit' | 'protect' | 'withdrawBankroll' | 'withdrawProtected'

type WalletBalances = {
  celo: string
  stable: string
}

type VaultAccount = {
  bankroll: string
  protectedSavings: string
  unlockAt: number
}

const EDIT_WINDOW_MS = 5 * 60 * 1000
const SETTLEMENT_EDIT_WINDOW_MS = 2 * 60 * 1000
const seededAt = Date.now()

const starterBets: BetSlip[] = [
  {
    id: 1,
    createdAt: seededAt - 2 * 60 * 1000,
    legs: [
      { id: 11, fixture: 'Gor Mahia vs AFC Leopards', odds: 1.85 },
      { id: 12, fixture: 'Tusker vs Shabana', odds: 1.72 },
    ],
    platform: 'Betika',
    stake: 500,
    status: 'lost',
  },
  {
    id: 2,
    createdAt: seededAt - 8 * 60 * 1000,
    legs: [
      { id: 21, fixture: 'Arsenal vs Chelsea', odds: 2.1 },
      { id: 22, fixture: 'Man City vs Spurs', odds: 1.44 },
      { id: 23, fixture: 'Liverpool vs Everton', odds: 1.63 },
    ],
    platform: 'Mozzart',
    stake: 250,
    status: 'won',
  },
  {
    id: 3,
    createdAt: seededAt - 12 * 60 * 1000,
    legs: [
      { id: 31, fixture: 'Kenya vs Uganda', odds: 1.9 },
      { id: 32, fixture: 'Nigeria vs Ghana', odds: 2.2 },
    ],
    platform: 'SportPesa',
    stake: 300,
    status: 'pending',
  },
]

const platforms = ['Betika', 'Mozzart', 'SportPesa', 'Odibets']

function getWalletClient() {
  if (!window.ethereum) {
    throw new Error('Open this app in MiniPay or another Celo wallet.')
  }

  return createWalletClient({
    chain: ACTIVE_CHAIN,
    transport: custom(window.ethereum),
  })
}

function getPublicClient() {
  return createPublicClient({
    chain: ACTIVE_CHAIN,
    transport: http(),
  })
}

function App() {
  const entryFormRef = useRef<HTMLFormElement | null>(null)
  const [bets, setBets] = useState(starterBets)
  const [legs, setLegs] = useState<BetLeg[]>([{ id: 1, fixture: '', odds: 1.9 }])
  const [availablePlatforms, setAvailablePlatforms] = useState(platforms)
  const [platform, setPlatform] = useState(platforms[0])
  const [newPlatform, setNewPlatform] = useState('')
  const [stake, setStake] = useState(200)
  const [status, setStatus] = useState<BetStatus>('pending')
  const [lossLimit, setLossLimit] = useState(1500)
  const [editingBetId, setEditingBetId] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [wallet, setWallet] = useState<Address | null>(null)
  const [walletMessage, setWalletMessage] = useState('Wallet not connected')
  const [balances, setBalances] = useState<WalletBalances | null>(null)
  const [vaultAccount, setVaultAccount] = useState<VaultAccount | null>(null)
  const [balanceMessage, setBalanceMessage] = useState('Connect MiniPay to check testnet balances.')
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultAmount, setVaultAmount] = useState(10)
  const [lockDays, setLockDays] = useState(30)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const stats = useMemo(() => {
    const settled = bets.filter((bet) => bet.status !== 'pending')
    const totalStaked = settled.reduce((sum, bet) => sum + bet.stake, 0)
    const returned = settled.reduce((sum, bet) => {
      return sum + (bet.status === 'won' ? getPotentialReturn(bet) : 0)
    }, 0)
    const net = returned - totalStaked
    const losses = settled
      .filter((bet) => bet.status === 'lost')
      .reduce((sum, bet) => sum + bet.stake, 0)
    const wins = settled.filter((bet) => bet.status === 'won').length
    const roi = totalStaked ? (net / totalStaked) * 100 : 0
    const winRate = settled.length ? (wins / settled.length) * 100 : 0

    return { losses, net, returned, roi, totalStaked, winRate }
  }, [bets])

  const limitPercent = Math.min((stats.losses / lossLimit) * 100, 100)
  const isLimitHit = stats.losses >= lossLimit

  async function connectWallet() {
    try {
      const client = getWalletClient()
      const [account] = await client.requestAddresses()
      setWallet(account)

      const isMiniPay = Boolean(window.ethereum?.isMiniPay)
      setWalletMessage(isMiniPay ? 'MiniPay wallet connected' : 'Celo wallet connected')
      void refreshBalances(account)
      void refreshVaultAccount(account)
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : 'Wallet connection failed')
    }
  }

  async function refreshBalances(account = wallet) {
    if (!account) {
      setBalanceMessage('Connect MiniPay to check testnet balances.')
      return
    }

    try {
      const client = getPublicClient()
      const [nativeBalance, stableBalance] = await Promise.all([
        client.getBalance({ address: account }),
        client.readContract({
          address: STABLE_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        }),
      ])

      setBalances({
        celo: Number(formatEther(nativeBalance)).toFixed(4),
        stable: Number(formatUnits(stableBalance, STABLE_TOKEN_DECIMALS)).toFixed(2),
      })
      setBalanceMessage('Balances updated.')
    } catch (error) {
      setBalanceMessage(error instanceof Error ? error.message : 'Could not load balances.')
    }
  }

  async function refreshVaultAccount(account = wallet) {
    if (!account || !VAULT_ADDRESS) {
      setVaultAccount(null)
      return
    }

    try {
      const client = getPublicClient()
      const result = await client.readContract({
        address: VAULT_ADDRESS,
        abi: [
          {
            inputs: [{ internalType: 'address', name: '', type: 'address' }],
            name: 'accounts',
            outputs: [
              { internalType: 'uint256', name: 'bankroll', type: 'uint256' },
              { internalType: 'uint256', name: 'protectedSavings', type: 'uint256' },
              { internalType: 'uint256', name: 'unlockAt', type: 'uint256' },
              { internalType: 'uint256', name: 'monthlyLossLimit', type: 'uint256' },
              { internalType: 'uint256', name: 'lockDays', type: 'uint256' },
            ],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        functionName: 'accounts',
        args: [account],
      })
      const [bankroll, protectedSavings, unlockAt] = result

      setVaultAccount({
        bankroll: Number(formatUnits(bankroll, STABLE_TOKEN_DECIMALS)).toFixed(2),
        protectedSavings: Number(formatUnits(protectedSavings, STABLE_TOKEN_DECIMALS)).toFixed(2),
        unlockAt: Number(unlockAt),
      })
    } catch {
      setVaultAccount(null)
    }
  }

  async function addStableTokenToWallet() {
    if (!window.ethereum?.request) {
      setBalanceMessage(`Connect MiniPay before adding ${STABLE_TOKEN_SYMBOL}.`)
      return
    }

    try {
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: [{
          type: 'ERC20',
          options: {
            address: STABLE_TOKEN_ADDRESS,
            decimals: STABLE_TOKEN_DECIMALS,
            symbol: STABLE_TOKEN_SYMBOL,
          },
        }],
      })
      setBalanceMessage(`${STABLE_TOKEN_SYMBOL} token request sent to wallet.`)
    } catch (error) {
      setBalanceMessage(error instanceof Error ? error.message : `Could not add ${STABLE_TOKEN_SYMBOL} token.`)
    }
  }

  async function copyWalletAddress() {
    if (!wallet) {
      setBalanceMessage('Connect MiniPay first.')
      return
    }

    await navigator.clipboard.writeText(wallet)
    setBalanceMessage('Wallet address copied.')
  }

  async function runVaultAction(action: VaultAction) {
    if (vaultBusy) {
      return
    }

    if (!VAULT_ADDRESS) {
      setWalletMessage('Set VITE_VAULT_ADDRESS after deploying the vault.')
      return
    }

    try {
      setVaultBusy(true)
      const client = getWalletClient()
      const publicClient = getPublicClient()
      const [account] = await client.requestAddresses()
      const amount = parseUnits(String(vaultAmount), STABLE_TOKEN_DECIMALS)

      if (action === 'deposit') {
        setWalletMessage(`Approving ${STABLE_TOKEN_SYMBOL} spend...`)
        const approvalHash = await client.writeContract({
          account,
          address: STABLE_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [VAULT_ADDRESS, amount],
        })
        setWalletMessage(`Approval sent: ${approvalHash.slice(0, 10)}... waiting for confirmation.`)
        await publicClient.waitForTransactionReceipt({ hash: approvalHash })

        setWalletMessage(`Depositing ${STABLE_TOKEN_SYMBOL} into vault...`)
        const hash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
              name: 'deposit',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'deposit',
          args: [amount],
        })

        setWallet(account)
        setWalletMessage(`Vault transaction sent: ${hash.slice(0, 10)}...`)
        void refreshBalances(account)
        void refreshVaultAccount(account)
        return
      }

      if (action === 'withdrawBankroll') {
        setWalletMessage(`Withdrawing available ${STABLE_TOKEN_SYMBOL} bankroll...`)
        const hash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
              name: 'withdrawBankroll',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'withdrawBankroll',
          args: [amount],
        })

        setWallet(account)
        setWalletMessage(`Withdraw transaction sent: ${hash.slice(0, 10)}...`)
        void refreshBalances(account)
        void refreshVaultAccount(account)
        return
      }

      if (action === 'protect') {
        setWalletMessage('Saving protection rules...')
        const rulesHash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [
                { internalType: 'uint256', name: 'monthlyLossLimit', type: 'uint256' },
                { internalType: 'uint256', name: 'lockDays', type: 'uint256' },
              ],
              name: 'setProtectionRules',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'setProtectionRules',
          args: [0n, BigInt(lockDays)],
        })
        await publicClient.waitForTransactionReceipt({ hash: rulesHash })
      }

      setWalletMessage(action === 'protect' ? 'Moving bankroll into protected savings...' : 'Withdrawing unlocked savings...')
      const hash = await client.writeContract({
        account,
        address: VAULT_ADDRESS,
        abi: [
          {
            inputs: [],
            name: action === 'protect' ? 'protectBalance' : 'withdrawProtectedSavings',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        functionName: action === 'protect' ? 'protectBalance' : 'withdrawProtectedSavings',
      })

      setWallet(account)
      setWalletMessage(`Vault transaction sent: ${hash.slice(0, 10)}...`)
      void refreshBalances(account)
      void refreshVaultAccount(account)
    } catch (error) {
      setWalletMessage(getVaultErrorMessage(error))
    } finally {
      setVaultBusy(false)
    }
  }

  function addBet() {
    const cleanedLegs = legs
      .filter((leg) => leg.fixture.trim() && leg.odds > 1)
      .map((leg) => ({ ...leg, fixture: leg.fixture.trim() }))

    if (!cleanedLegs.length || stake <= 0) {
      return
    }

    if (editingBetId) {
      setBets((current) => current.map((bet) => (
        bet.id === editingBetId
          ? { ...bet, legs: cleanedLegs, platform, stake, status }
          : bet
      )))
      setEditingBetId(null)
    } else {
      setBets((current) => [
        {
          id: Date.now(),
          createdAt: Date.now(),
          legs: cleanedLegs,
          platform,
          stake,
          status,
        },
        ...current,
      ])
    }

    setLegs([{ id: Date.now() + 1, fixture: '', odds: 1.9 }])
    setStake(200)
    setStatus('pending')
  }

  function updateLeg(id: number, patch: Partial<BetLeg>) {
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)))
  }

  function addLeg() {
    setLegs((current) => [...current, { id: Date.now(), fixture: '', odds: 1.9 }])
  }

  function removeLeg(id: number) {
    setLegs((current) => current.length === 1 ? current : current.filter((leg) => leg.id !== id))
  }

  function updateBetStatus(id: number, nextStatus: BetStatus) {
    setBets((current) => current.map((bet) => {
      if (bet.id !== id) {
        return bet
      }

      if (bet.status === nextStatus) {
        return bet
      }

      return {
        ...bet,
        settledAt: nextStatus === 'pending' ? undefined : Date.now(),
        status: nextStatus,
      }
    }))
  }

  function editBet(bet: BetSlip) {
    if (!canEditSlip(bet, now)) {
      return
    }

    setEditingBetId(bet.id)
    setLegs(bet.legs.map((leg) => ({ ...leg })))
    setPlatform(bet.platform)
    setStake(bet.stake)
    setStatus(bet.status)

    if (!availablePlatforms.includes(bet.platform)) {
      setAvailablePlatforms((current) => [...current, bet.platform])
    }

    window.setTimeout(() => {
      entryFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  function cancelEdit() {
    setEditingBetId(null)
    setLegs([{ id: Date.now() + 1, fixture: '', odds: 1.9 }])
    setStake(200)
    setStatus('pending')
  }

  function addPlatform() {
    const cleaned = newPlatform.trim()

    if (!cleaned) {
      return
    }

    setAvailablePlatforms((current) => {
      const existing = current.find((item) => item.toLowerCase() === cleaned.toLowerCase())
      if (existing) {
        setPlatform(existing)
        return current
      }

      setPlatform(cleaned)
      return [...current, cleaned]
    })
    setNewPlatform('')
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Celo Proof of Ship</p>
          <h1>AkibaBet</h1>
          <span className="networkBadge">
            {CELO_NETWORK === 'sepolia' ? 'Celo Sepolia Testnet' : 'Celo Mainnet'}
          </span>
        </div>
        <button className="iconButton" type="button" onClick={connectWallet} title="Connect wallet">
          <Wallet size={18} />
          <span>{wallet ? 'Connected' : 'Connect'}</span>
        </button>
      </header>

      <section className="heroPanel">
        <div className="heroCopy">
          <p className="eyebrow">Betting tracker + bankroll protection</p>
          <h2>See the real ROI before emotion spends the rest.</h2>
          <p>
            Track every betslip from Kenyan betting platforms, face the real profit/loss,
            and move protected {STABLE_TOKEN_SYMBOL} into a time-locked savings vault.
          </p>
        </div>
        <div className={isLimitHit ? 'limitCard danger' : 'limitCard'}>
          <ShieldCheck size={22} />
          <span>Monthly loss limit</span>
          <strong>{formatKes(stats.losses)} / {formatKes(lossLimit)}</strong>
          <div className="progressTrack">
            <span style={{ width: `${limitPercent}%` }} />
          </div>
          <small>{isLimitHit ? 'Protection triggered' : 'Still below your limit'}</small>
        </div>
      </section>

      <section className="metricsGrid">
        <Metric label="Net position" value={formatKes(stats.net)} tone={stats.net < 0 ? 'bad' : 'good'} />
        <Metric label="Real ROI" value={`${stats.roi.toFixed(1)}%`} tone={stats.roi < 0 ? 'bad' : 'good'} />
        <Metric label="Total staked" value={formatKes(stats.totalStaked)} />
        <Metric label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
      </section>

      {CELO_NETWORK === 'sepolia' && (
        <section className="testnetPanel">
          <div>
            <p className="eyebrow">Testnet funding</p>
            <h3>Get {STABLE_TOKEN_SYMBOL} into MiniPay Sepolia</h3>
            <p>
              Claim testnet CELO for gas, then get faucet {STABLE_TOKEN_SYMBOL}
              before testing vault deposits.
            </p>
          </div>
          <div className="balanceGrid">
            <article>
              <span>CELO</span>
              <strong>{balances?.celo ?? '--'}</strong>
            </article>
            <article>
              <span>{STABLE_TOKEN_SYMBOL}</span>
              <strong>{balances?.stable ?? '--'}</strong>
            </article>
          </div>
          <div className="testnetActions">
            <button type="button" onClick={connectWallet}>
              <Wallet size={16} />
              Connect
            </button>
            <button type="button" onClick={copyWalletAddress}>
              <Copy size={16} />
              Copy address
            </button>
            <a href={CELO_SEPOLIA_FAUCET_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              CELO faucet
            </a>
            <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              {STABLE_TOKEN_SYMBOL} faucet
            </a>
            <button type="button" onClick={addStableTokenToWallet}>
              <Plus size={16} />
              Add {STABLE_TOKEN_SYMBOL}
            </button>
            <button type="button" onClick={() => refreshBalances()}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
          <p className="helperText">{balanceMessage}</p>
        </section>
      )}

      <section className="workspace">
        <form
          ref={entryFormRef}
          className={editingBetId ? 'entryPanel editing' : 'entryPanel'}
          onSubmit={(event) => { event.preventDefault(); addBet() }}
        >
          <div className="sectionHeader">
            <Plus size={18} />
            <h3>{editingBetId ? 'Edit betslip' : 'Log betslip'}</h3>
          </div>
          {editingBetId && (
            <div className="editNotice">
              <strong>Editing open</strong>
              <span>Games, odds, stake, platform, and result can be changed.</span>
            </div>
          )}
          <div className="legsEditor">
            {legs.map((leg, index) => (
              <div className="legInput" key={leg.id}>
                <label>
                  Game {index + 1}
                  <input
                    value={leg.fixture}
                    onChange={(event) => updateLeg(leg.id, { fixture: event.target.value })}
                    placeholder="Kenya vs Uganda"
                  />
                </label>
                <label>
                  Odds
                  <input
                    type="number"
                    min="1.01"
                    step="0.01"
                    value={leg.odds}
                    onChange={(event) => updateLeg(leg.id, { odds: Number(event.target.value) })}
                  />
                </label>
                <button
                  className="smallIconButton"
                  type="button"
                  onClick={() => removeLeg(leg.id)}
                  title="Remove game"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button className="secondaryButton" type="button" onClick={addLeg}>
              <Plus size={16} />
              Add game
            </button>
          </div>
          <div className="fieldPair">
            <label>
              Platform
              <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                {availablePlatforms.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value as BetStatus)}>
                <option value="pending">Pending</option>
                <option value="won">Won</option>
                <option value="lost">Lost</option>
              </select>
            </label>
          </div>
          <div className="addPlatformRow">
            <label>
              Add platform
              <input
                value={newPlatform}
                onChange={(event) => setNewPlatform(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addPlatform()
                  }
                }}
                placeholder="e.g. Betway"
              />
            </label>
            <button className="smallIconButton addPlatformButton" type="button" onClick={addPlatform} title="Add platform">
              <Plus size={16} />
            </button>
          </div>
          <label>
            Betslip stake KES
            <input type="number" min="1" value={stake} onChange={(event) => setStake(Number(event.target.value))} />
          </label>
          <label>
            Monthly loss limit KES
            <input type="number" min="100" value={lossLimit} onChange={(event) => setLossLimit(Number(event.target.value))} />
          </label>
          <button className="primaryButton" type="submit">
            <Plus size={18} />
            {editingBetId ? 'Save betslip' : 'Add betslip'}
          </button>
          {editingBetId && (
            <button className="secondaryButton cancelEditButton" type="button" onClick={cancelEdit}>
              Cancel edit
            </button>
          )}
        </form>

        <div className="vaultPanel">
          <div className="sectionHeader">
            <Landmark size={18} />
            <h3>{STABLE_TOKEN_SYMBOL} bankroll vault</h3>
          </div>
          <div className="walletStatus">
            <BadgeCheck size={18} />
            <span>{walletMessage}</span>
          </div>
          <div className="vaultBalanceGrid">
            <article>
              <span>Available bankroll</span>
              <strong>{vaultAccount?.bankroll ?? '--'} {STABLE_TOKEN_SYMBOL}</strong>
            </article>
            <article>
              <span>Protected savings</span>
              <strong>{vaultAccount?.protectedSavings ?? '--'} {STABLE_TOKEN_SYMBOL}</strong>
            </article>
          </div>
          <p className="helperText">
            Deposit adds available bankroll. Protect balance locks all available bankroll for {lockDays} days.
            Withdraw savings works only after funds are protected and the lock has expired.
          </p>
          <label>
            Amount {STABLE_TOKEN_SYMBOL}
            <input type="number" min="1" value={vaultAmount} onChange={(event) => setVaultAmount(Number(event.target.value))} />
          </label>
          <label>
            Savings lock days
            <input type="number" min="1" value={lockDays} onChange={(event) => setLockDays(Number(event.target.value))} />
          </label>
          <div className="vaultActions">
            <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('deposit')}>
              <Coins size={18} />
              {vaultBusy ? 'Working...' : 'Deposit'}
            </button>
            <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('withdrawBankroll')}>
              <Coins size={18} />
              Withdraw bankroll
            </button>
            <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('protect')}>
              <Lock size={18} />
              Protect balance
            </button>
            <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('withdrawProtected')}>
              <Coins size={18} />
              Withdraw savings
            </button>
          </div>
          <div className="contractBox">
            <span>Vault contract</span>
            <strong>{VAULT_ADDRESS ?? 'Deploy then set VITE_VAULT_ADDRESS'}</strong>
          </div>
        </div>
      </section>

      <section className="tickets">
        <div className="sectionHeader">
          <TrendingDown size={18} />
          <h3>Betslip history</h3>
        </div>
        {bets.map((bet) => (
          <article className="ticket" key={bet.id}>
            <div>
              <strong>{bet.platform} betslip</strong>
              <span>{bet.legs.length} games - combined odds {getCombinedOdds(bet.legs).toFixed(2)}</span>
              <ul className="legList">
                {bet.legs.map((leg) => (
                  <li key={leg.id}>
                    <span>{leg.fixture}</span>
                    <strong>{leg.odds.toFixed(2)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>{formatKes(bet.stake)}</strong>
              <span>Possible return {formatKes(getPotentialReturn(bet))}</span>
              <label className="statusEditor">
                Result
                <select
                  className={`statusSelect ${bet.status}`}
                  disabled={!canEditResult(bet, now)}
                  value={bet.status}
                  onChange={(event) => updateBetStatus(bet.id, event.target.value as BetStatus)}
                >
                  <option value="pending">Pending</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
              </label>
              {canEditSlip(bet, now) && (
                <button
                  className="secondaryButton editSlipButton"
                  type="button"
                  onClick={() => editBet(bet)}
                >
                  Edit {formatRemainingEditTime(bet, now)}
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}

function getCombinedOdds(legs: BetLeg[]) {
  return legs.reduce((product, leg) => product * leg.odds, 1)
}

function getPotentialReturn(bet: BetSlip) {
  return bet.stake * getCombinedOdds(bet.legs)
}

function canEditSlip(bet: BetSlip, now: number) {
  if (bet.settledAt) {
    return now - bet.settledAt <= SETTLEMENT_EDIT_WINDOW_MS
  }

  return now - bet.createdAt <= EDIT_WINDOW_MS
}

function formatRemainingEditTime(bet: BetSlip, now: number) {
  const windowMs = bet.settledAt ? SETTLEMENT_EDIT_WINDOW_MS : EDIT_WINDOW_MS
  const start = bet.settledAt ?? bet.createdAt
  const remaining = Math.max(0, windowMs - (now - start))
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function canEditResult(bet: BetSlip, now: number) {
  if (bet.status === 'pending') {
    return true
  }

  return canEditSlip(bet, now)
}

function getVaultErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''

  if (message.includes('0x5c2262de') || message.includes('AmountMustBePositive')) {
    return 'Nothing to withdraw from that bucket yet. Use Withdraw bankroll for available deposits, or Protect balance before withdrawing protected savings.'
  }

  if (message.includes('0x2e6d26c0') || message.includes('SavingsStillLocked')) {
    return 'Protected savings are still locked. Wait until the unlock time before withdrawing savings.'
  }

  if (message.includes('0x2c0861a9') || message.includes('InsufficientBankroll')) {
    return 'You are trying to withdraw more than the available bankroll.'
  }

  if (message.includes('allowance')) {
    return 'Token approval has not confirmed yet. Try deposit again after the approval finishes.'
  }

  return error instanceof Error ? error.message : 'Vault transaction failed'
}

function Metric({ label, tone, value }: { label: string; tone?: 'good' | 'bad'; value: string }) {
  return (
    <article className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function formatKes(value: number) {
  return new Intl.NumberFormat('en-KE', {
    currency: 'KES',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value)
}

declare global {
  interface Window {
    ethereum?: {
      isMiniPay?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

export default App

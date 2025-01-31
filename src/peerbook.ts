/* Terminal7 PeerBook connection
 * 
 * This file contains the code for the class used to comunicate with 
 * PeerBook 
 *
 *  Copyright: (c) 2022 Tuzig LTD
 *  License: GPLv3
 */

import { CustomerInfo } from "@revenuecat/purchases-typescript-internal-esm"

export const PB = "\uD83D\uDCD6"
import { Device } from '@capacitor/device'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { HTTPWebRTCSession } from './webrtc_session'
import { Gate } from './gate'
import { Shell } from './shell'
import { Capacitor } from '@capacitor/core'
import {ERROR_HTML_SYMBOL, CLOSED_HTML_SYMBOL, OPEN_HTML_SYMBOL} from './terminal7'

interface PeerbookProps {
    fp: string,
    host: string,
    insecure: boolean,
    shell: Shell
}

interface Peer {
    name: string
    user: string
    kind: string
    verified: boolean
    created_on: number
    verified_on: number
    last_connected: number
    online: boolean
    auth_token?: string
}

export class PeerbookConnection {
    ws: WebSocket = null
    host: string
    insecure = false
    fp: string
    pbSendTask = null
    onUpdate: (r: string) => void
    pending: Array<string>
    session: HTTPWebRTCSession | null = null
    token: string
    shell: Shell
    uid: string
    updatingStore = false
    spinnerInterval = null
    headers: Map<string,string>

    constructor(props:PeerbookProps) {
        // copy all props to this
        Object.assign(this, props)
        this.pending = []
        this.token = ""
        this.headers = new Map<string, string>()
        this.uid = ""
    }

    async adminCommand(cmd: string, ...args: string[]): Promise<string> {
        const c = args?[cmd, ...args]:[cmd]
        if (!this.session) {
            console.log("Admin command with no session")
            try {
                await this.connect()
            } catch (e) {
                console.log("Failed to connect to peerbook", e)
                throw new Error("Failed to connect")
            }
        }   

        return new Promise((resolve, reject) => {
            const reply = []
            this.session.openChannel(c, 0, 80, 24).then(channel  => {
                channel.onClose = () => {
                    const ret =  new TextDecoder().decode(new Uint8Array(reply))
                    terminal7.log(`cmd ${cmd} ${args} closed with: ${ret}`)
                    resolve(ret)
                }
                channel.onMessage = (data: Uint8Array) => {
                    reply.push(...data)
                }
            }).catch(reject)
        })
    }

    async register() {
        let email: string
        let peerName: string
        let repStr: string
        let fp: string
        let userData

        this.echo("Registering with PeerBook")
        try {
            peerName = await this.shell.askValue("Peer name", (await Device.getInfo()).name)
            email = await this.shell.askValue("Recovery email")
        } catch (e) {
            console.log("Registration Cancelled", e)
            this.shell.t.writeln("Cancelled. Use `subscribe` to try again")
            await this.shell.escapeActiveForm()
            return
        }
        try {
            repStr = await this.adminCommand("register", email, peerName)
        } catch (e) {
            this.shell.t.writeln(`${PB} Registration failed\n    Please try again and if persists, \`support\``)
            this.shell.printPrompt()
            return
        }
            
        try {
            userData = JSON.parse(repStr)
        } catch (e) {
            this.shell.t.writeln(`${PB} Registration failed\n    Please try again and if persists, \`support\``)
            this.shell.printPrompt()
            return
        }
        const QR = userData.QR
        const uid = userData.ID
        this.uid = uid
        // eslint-disable-next-line
        this.echo("Please scan this QR code with your OTP app")
        this.echo(QR)
        this.echo("")
        this.echo("and use it to generate a One Time Password")
        // verify ourselves - it's the first time and we were approved thanks 
        // to the revenuecat's user id
        this.shell.startWatchdog(3000).catch(() => {
            this.shell.t.writeln("Timed out waiting for OTP")
            this.shell.printPrompt()
        })
        try {
            fp = await terminal7.getFingerprint()
        } catch (e) {
            this.shell.t.writeln("Failed to get fingerprint")
            this.shell.printPrompt()
            return
        }
        try {
            await this.verifyFP(fp, "OTP")
        } catch (e) {
            console.log("error verifying OTP", e.toString())
            this.shell.t.writeln("Failed to verify OTP")
            this.shell.printPrompt()
            return
        } finally {
            this.shell.stopWatchdog()
        }
        await Purchases.logIn({ appUserID: uid })
        this.shell.t.writeln("Validated! Use `install` to install on a server")
        try {
            await this.wsConnect()
        } catch (e) {
            this.shell.t.writeln("Failed to connect to PeerBook")
            console.log("Failed to connect to PeerBook", e)
        }
        this.shell.printPrompt()
    }
    async startPurchases() {
        console.log("Starting purchases")
        await Purchases.setMockWebResults({ shouldMockWebResults: true })
        const keys = {
            ios: 'appl_qKHwbgKuoVXokCTMuLRwvukoqkd',
            android: 'goog_ncGFZWWmIsdzdfkyMRtPqqyNlsx'
        }
        const props = {
            apiKey: keys[Capacitor.getPlatform()],
        }

        try {
            await Purchases.configure(props)
        } catch (e) {
            terminal7.log("Failed to setup purchases", e)
            return
        }
    }

    /*
     * gets customer info from revenuecat and act on it
    */
    async updateCustomerInfo() {
        let data: {
            customerInfo: CustomerInfo;
        }
        try {
            data = await Purchases.getCustomerInfo()
        } catch (e) {
            terminal7.log("Failed to get customer info", e)
            return
        }
        await this.onPurchasesUpdate(data)
    }

    async onPurchasesUpdate(data) {
        console.log("onPurchasesUpdate", data)
            // intialize the http headers with the bearer token
        if (this.updatingStore) {
            terminal7.log("got anotyher evenm while updatingStore")
            return
        }
        const active = data.customerInfo.entitlements.active
        this.close()
        if (!active.peerbook) {
            this.updatingStore = false
            return
        }
        this.shell.stopWatchdog()
        const uid = data.customerInfo.originalAppUserId
        terminal7.log("Subscribed to PB, uid: ", uid)
        try {
            await this.connect(uid)
        } catch (e) {
            terminal7.log("Failed to connect", e)
        } finally {
            this.updatingStore = false
        }
    }
    async echo(data: string) {
        this.shell.t.writeln(data)
    }

    getUID() {
        return new Promise<string>((resolve, reject) => {
            if ((this.uid != "TBD") && (this.uid != "")) {
                resolve(this.uid)
                return
            }
            if (!this.session) {
                console.log("get UID with No session")
                reject("No session")
                return
            }
            this.adminCommand("ping").then((uid: string) => {
                this.uid = uid
                resolve(uid)
            }).catch(reject)
        })
    }
            

    async connect(token?: string) {
        return new Promise<void>((resolve, reject) =>{
            if (this.session) {
                if (this.uid == "TBD")
                    reject("Unregistered")
                else
                    resolve()
                return
            }
            // connect to admin over webrtc
            const schema = terminal7.conf.peerbook.insecure? "http" : "https"
            const url = `${schema}://${terminal7.conf.net.peerbook}/we`
            if (token)
                this.headers.set("Authorization", `Bearer ${token}`)
            const session = new HTTPWebRTCSession(url, this.headers)
            this.session = session
            session.onStateChange = (state, failure?) => {
                if (state == 'connected') {
                    terminal7.log("Connected PB webrtc connection")
                    // send a ping to get the uid
                    this.getUID().then(uid => {
                        if (uid == "TBD") {
                            terminal7.log("Got TBD as uid")
                            reject("Unregistered")
                        } else {
                            Purchases.logIn({ appUserID: uid })
                            this.wsConnect().then(resolve).catch(reject)
                        }
                    }).catch(e => {
                        this.session = null
                        terminal7.log("Failed to get user id", e.toString())
                        resolve()
                    })
                    return
                }
                else if (state == 'failed') {
                    this.stopSpinner()
                    this.session = null
                    console.log("PB webrtc connection failed", failure)
                    if (this.uid == "TBD")
                        reject("Unregistered")
                    else
                        reject(failure)
                    return
                }
            }
            session.connect()
        })
    }
    async wsConnect() {
        console.log("peerbook wsConnect called")
        let firstMessage = true
        return new Promise<void>((resolve, reject) => {
            if (this.ws != null) {
                if (this.isOpen()) {
                    resolve()
                    return
                }
                this.ws.onopen = undefined
                this.ws.onmessage = undefined
                this.ws.onerror = undefined
                this.ws.onclose = undefined
                try {
                    this.ws.close()
                } catch (e) {
                    terminal7.log("ws close failed", e)
                }
            }
            const schema = this.insecure?"ws":"wss",
                  url = encodeURI(`${schema}://${this.host}/ws?fp=${this.fp}`),
                  statusE = document.getElementById("peerbook-status"),
                  ws = new WebSocket(url)
            this.ws = ws
            ws.onmessage = ev => {
                const m = JSON.parse(ev.data)
                if (m.code >= 400) {
                    console.log("peerbook connect got code", m.code)
                    this.stopSpinner()
                    statusE.innerHTML = ERROR_HTML_SYMBOL
                    // reject(`PeerBook connection error ${m.code}`)
                    return
                } 
                if (firstMessage) {
                    this.stopSpinner()
                    firstMessage = false
                    resolve()
                }
                if (this.onUpdate)
                    this.onUpdate(m)
                else
                    terminal7.log("got ws message but no onUpdate", m)
            }
            ws.onerror = ev =>  {
                terminal7.log("peerbook ws error", ev.toString())
                this.ws = null
                this.stopSpinner()
                statusE.innerHTML = ERROR_HTML_SYMBOL
                reject()
            }
            ws.onclose = (ev) => {
                terminal7.log("peerbook ws closed", ev)
                this.ws = null
                this.stopSpinner()
                if (statusE.innerHTML != ERROR_HTML_SYMBOL)
                    statusE.innerHTML = CLOSED_HTML_SYMBOL
            }
            ws.onopen = () => {
                console.log("peerbook ws open")
                if ((this.pbSendTask == null) && (this.pending.length > 0))
                    this.pbSendTask = setTimeout(() => {
                        this.pending.forEach(m => {
                            console.log("sending ", m)
                            ws.send(JSON.stringify(m))
                        })
                        this.pbSendTask = null
                        this.pending = []
                    }, 10)
            }
        })
    }
    send(m) {
        // null message are used to trigger connection, ignore them
        const state = this.ws ? this.ws.readyState : WebSocket.CLOSED
        if (state == WebSocket.OPEN) {
            this.ws.send(JSON.stringify(m))
        } else {
            terminal7.log("peerbook send called with state", state)
            this.pending.push(m)
        }
    }
    close() {
        if (this.ws) {
            this.ws.onopen = undefined
            this.ws.onmessage = undefined
            this.ws.onerror = undefined
            this.ws.onclose = undefined
            this.ws.close()
            this.ws = null
        }
        if (this.session) {
            this.session.onStateChange = undefined
            this.session.close()
            this.session = null
        }
    }
    isOpen() {
        return (this.ws ? this.ws.readyState === WebSocket.OPEN : false)
    }
    syncPeers(gates: Array<Gate>, nPeers: Array<Peer>) {
        const ret = []
        const index = {}
        gates.forEach(p => {
            ret.push(p)
            index[p.name] = p
        })
        if (!nPeers)
            return ret
        nPeers.forEach(p => {
            if (p.kind != "webexec")
                return
            let gate = index[p.name]
            if (!gate) {
                gate = new Gate(p)
                gate.id = ret.length
                gate.nameE = terminal7.map.add(gate)
                gate.open(terminal7.e)
                ret.push(gate)
            }
            for (const k in p) {
                gate[k] = p[k]
            }
            gate.updateNameE()
        })
        return ret
    }
    async verifyFP(fp: string, prompt?: string) {
        let validated = false
        // TODO:gAdd biometrics verification
        while (!validated) {
            console.log("Verifying FP", fp)
            let otp: string
            try {
                otp = await this.shell.askValue(prompt || "Enter OTP to verify gate")
            } catch(e) {
                return
            }
            if (!this.session) {
                console.log("verifyFP: creating new session")
                await this.connect()
            }
            let data
            try {
                data = await this.adminCommand("verify", fp, otp)
            } catch(e) {
                console.log("verifyFP: failed to verify", e.toString())
                this.echo("Failed to verify, please try again")
                continue
            }
            console.log("Got verify reply", data[0])
            validated = data[0] == "1"
            if (!validated)
                this.echo("Invalid OTP, please try again")
        }
    }
    purchase(aPackage): Promise<void> {
        return new Promise((resolve, reject) => {
            // ensure there's only one listener
            Purchases.purchasePackage({ aPackage }).then(customerInfo => {
                this.onPurchasesUpdate(customerInfo).then(resolve).catch(reject)
            }).catch(e => {
                console.log("purchase failed", e)
                reject(e)
            })
        })
    }   
    stopSpinner() {
        const statusE = document.getElementById("peerbook-status") as HTMLElement
        statusE.style.opacity = "1"
        if (this.spinnerInterval) {
            clearInterval(this.spinnerInterval)
            this.spinnerInterval = null
        }
    }
    startSpinner() {
        const statusE = document.getElementById("peerbook-status")
        let i = 0.1, change = 0.1
        if (this.spinnerInterval)
            return
        this.spinnerInterval = setInterval(() => {
            i = i + change 
            if (i > 1 || i < 0) {
                change = -change
                i = i + change
            }
            statusE.style.opacity = String(i)
        }, 200)
        statusE.innerHTML = OPEN_HTML_SYMBOL
        statusE.style.opacity = "0"
    }
}

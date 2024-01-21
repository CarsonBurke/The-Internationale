import { Sleepable } from 'utils/sleepable'
import { packXYAsNum, randomIntRange, roundTo, utils } from '../utils/utils'

import {
  WorkRequestKeys,
  mmoShardNames,
  roomDimensions,
  RoomMemoryKeys,
  minerals,
  haulerUpdateDefault,
} from './constants'
import { communeUtils } from 'room/commune/communeUtils'

const periodicUpdateInterval = randomIntRange(100, 200)

/**
 * Handles inter room and non-room matters
 */
export class CollectiveManager extends Sleepable {
  /**
   * Antifa creeps by combat request name, then by role with an array of creep names
   */
  creepsByCombatRequest: { [requestName: string]: Partial<{ [key in CreepRoles]: string[] }> }

  creepsByHaulRequest: { [requestName: string]: string[] }

  unspawnedPowerCreepNames: string[]

  terminalRequests: { [ID: string]: TerminalRequest }

  tickID: number
  customCreepIDs: true[]
  customCreepIDIndex: number

  internationalDataVisuals: boolean

  terminalCommunes: string[]

  /**
   * The aggregate number of each mineral nodes we have access to
   */
  mineralNodes: Partial<{ [key in MineralConstant]: number }>

  /**
   * The name of the room that is safemoded, if there is one
   */
  safemodedCommuneName: string | undefined
  /**
   * An intra-tick collection of commands we wish to issue
   */
  myCommands: any[]
  /**
   * Terrain binaries of wall or not wall for rooms
   */
  terrainBinaries: { [roomName: string]: Uint8Array } = {}
  constructionSiteCount = 0
  creepCount: number
  powerCreepCount: number
  /**
   * A string to console log as rich text
   */
  logs = ''
  /**
   * Room names that have controllers we own
   */
  communes: Set<string>
  communesForWorkRequests: Set<string>
  communesForCombatRequests: Set<string>
  communesForHaulRequests: Set<string>

  /**
   * Updates values to be present for this tick
   */
  update() {
    // initalize or re-initialize

    this.creepsByCombatRequest = {}
    this.creepsByHaulRequest = {}
    this.unspawnedPowerCreepNames = []
    this.terminalRequests = {}
    this.terminalCommunes = []

    this.tickID = 0
    this.customCreepIDs = []
    this.customCreepIDIndex = 0
    this.mineralNodes = {}
    for (const mineralType of minerals) {
      this.mineralNodes[mineralType] = 0
    }
    this.myCommands = []
    this.logs = ''
    this.creepCount = 0
    this.powerCreepCount = 0
    this.communes = new Set()
    this.communesForWorkRequests = new Set()
    this.communesForCombatRequests = new Set()
    this.communesForHaulRequests = new Set()

    // delete

    this.safemodedCommuneName = undefined
    this._workRequestsByScore = undefined
    this._defaultMinCacheAmount = undefined
    this.internationalDataVisuals = undefined

    //

    this.updateMinHaulerCost()

    // Run this stuff every so often

    if (utils.isTickInterval(periodicUpdateInterval)) {
      // delete

      this._funnelOrder = undefined
      this._funnelingRoomNames = undefined
      this._minCredits = undefined
      this._resourcesInStoringStructures = undefined
      this._maxCSitesPerRoom = undefined
    }

    //
  }

  newCustomCreepID() {
    // Try to use an existing unused ID index

    for (; this.customCreepIDIndex < this.customCreepIDs.length; this.customCreepIDIndex++) {
      if (this.customCreepIDs[this.customCreepIDIndex]) continue

      this.customCreepIDs[this.customCreepIDIndex] = true
      this.customCreepIDIndex += 1
      return this.customCreepIDIndex - 1
    }

    // All previous indexes are being used, add a new index

    this.customCreepIDs.push(true)
    this.customCreepIDIndex += 1
    return this.customCreepIDIndex - 1
  }

  advancedGeneratePixel() {
    if (!global.settings.pixelGeneration) return

    // Stop if the bot is not running on MMO
    if (!mmoShardNames.has(Game.shard.name)) return

    // Stop if the cpu bucket isn't full
    if (Game.cpu.bucket !== 10000) return

    Game.cpu.generatePixel()
  }

  updateMinHaulerCost() {
    if (Game.time - Memory.minHaulerCostUpdate < haulerUpdateDefault) return

    // cpu limit is potentially variable if GCL changes
    const targetCPU = (Game.cpu.limit * 0.9) / Game.cpu.limit
    // How far off we are from our ideal cpu usage
    Memory.minHaulerCostError = roundTo(targetCPU - Memory.stats.cpu.usage / Game.cpu.limit, 4)

    Memory.minHaulerCost -= Math.floor((Memory.minHaulerCost * Memory.minHaulerCostError) / 2)

    Memory.minHaulerCost = Math.max(
      Memory.minHaulerCost,
      BODYPART_COST[CARRY] * 2 + BODYPART_COST[MOVE],
    )

    // don't let it exceed the max possible cost by too much (otherwise will take awhile to match delta in some circumstances)
    Memory.minHaulerCost = Math.min(
      Memory.minHaulerCost,
      BODYPART_COST[MOVE] * MAX_CREEP_SIZE * 1.2,
    )

    Memory.minHaulerCostUpdate = Game.time
  }

  /**
   * Provides a cached binary of wall or not wall terrain
   */
  getTerrainBinary(roomName: string) {
    if (this.terrainBinaries[roomName]) return this.terrainBinaries[roomName]

    this.terrainBinaries[roomName] = new Uint8Array(2500)

    const terrain = Game.map.getRoomTerrain(roomName)

    for (let x = 0; x < roomDimensions; x += 1) {
      for (let y = 0; y < roomDimensions; y += 1) {
        this.terrainBinaries[roomName][packXYAsNum(x, y)] =
          terrain.get(x, y) === TERRAIN_MASK_WALL ? 255 : 0
      }
    }

    return this.terrainBinaries[roomName]
  }

  newTickID() {
    return (this.tickID += 1).toString()
  }

  _minCredits: number
  get minCredits() {
    if (this._minCredits !== undefined) return this._minCredits

    return (this._minCredits = collectiveManager.communes.size * 10000)
  }

  _workRequestsByScore: (string | undefined)[]
  get workRequestsByScore(): (string | undefined)[] {
    if (this._workRequestsByScore) return this._workRequestsByScore

    return (this._workRequestsByScore = Object.keys(Memory.workRequests).sort(
      (a, b) =>
        (Memory.workRequests[a][WorkRequestKeys.priority] ??
          Memory.rooms[a][RoomMemoryKeys.score] + Memory.rooms[a][RoomMemoryKeys.dynamicScore]) -
        (Memory.workRequests[b][WorkRequestKeys.priority] ??
          Memory.rooms[b][RoomMemoryKeys.score] + Memory.rooms[b][RoomMemoryKeys.dynamicScore]),
    ))
  }

  _defaultMinCacheAmount: number
  get defaultMinPathCacheTime() {
    if (this._defaultMinCacheAmount !== undefined) return this._defaultMinCacheAmount

    const avgCPUUsagePercent = Memory.stats.cpu.usage / Game.cpu.limit

    return (this._defaultMinCacheAmount = Math.floor(Math.pow(avgCPUUsagePercent * 10, 2.2)) + 1)
  }

  _maxCommunes: number
  get maxCommunes() {
    return (this._maxCommunes = Math.round(Game.cpu.limit / 10))
  }

  _avgCommunesPerMineral: number
  get avgCommunesPerMineral() {
    let sum = 0

    for (const mineralType in this.mineralNodes) {
      sum += this.mineralNodes[mineralType as MineralConstant]
    }

    const avg = roundTo(sum / minerals.length, 2)
    return (this._avgCommunesPerMineral = avg)
  }

  _compoundPriority: Partial<{ [key in MineralCompoundConstant]: number }>
  get compoundPriority() {
    if (this._compoundPriority) return this._compoundPriority

    this._compoundPriority = {}

    return this._compoundPriority
  }

  _funnelOrder: string[]
  /**
   * Commune names sorted by funnel priority
   */
  getFunnelOrder() {
    if (this._funnelOrder) return this._funnelOrder

    let funnelOrder: string[] = []

    // organize RCLs 1-7

    const communesByLevel: { [level: string]: [string, number][] } = {}
    for (let i = 6; i < 8; i++) communesByLevel[i] = []

    for (const roomName of collectiveManager.communes) {
      const room = Game.rooms[roomName]
      if (!room.terminal) continue

      const { controller } = room
      if (!communesByLevel[controller.level]) continue

      communesByLevel[controller.level].push([
        roomName,
        controller.progressTotal / controller.progress,
      ])
    }

    for (const level in communesByLevel) {
      // Sort by score

      communesByLevel[level].sort((a, b) => {
        return a[1] - b[1]
      })

      funnelOrder = funnelOrder.concat(communesByLevel[level].map(tuple => tuple[0]))
    }

    return (this._funnelOrder = funnelOrder)
  }

  _funnelingRoomNames: Set<string>
  /**
   * The unordered names of rooms currently being funneled. Does 2 passes.
   * For a room to be in this list, it must be part of a censecutive line starting from index 0.
   * Take an example where x means the room is not wanting to be funneled and y means they are:
   * {y, y, y, x, y}.
   * The last room wants to be funneled, however, only the first 3 rooms will be, excluding the last 2: {y, y, y, x, x}.
   */
  getFunnelingRoomNames() {
    if (this._funnelingRoomNames) return this._funnelingRoomNames
    /* if (this._funnelingRoomNames) return this._funnelingRoomNames

    const funnelingRoomNames = new Set<string>()
    const funnelTargets = this.funnelOrder

    for (const roomName of funnelTargets) {
      const room = Game.rooms[roomName]
      if (!room.considerFunneled) {
        funnelingRoomNames.add(roomName)
        break
      }

      // Consider it funneled

      funnelingRoomNames.add(roomName)
    }

    this._funnelingRoomNames = funnelingRoomNames
    return funnelingRoomNames */

    const funnelOrder = this.getFunnelOrder()
    // Rooms that want to get funneled might not get to be if they aren't in line for funneling
    const funnelWanters = this.getFunnelWanters(funnelOrder)

    const funnelingRoomNames = new Set<string>()

    for (const roomName of funnelOrder) {
      if (!funnelWanters.has(roomName)) {
        break
      }

      // Consider it funneled

      funnelingRoomNames.add(roomName)
    }

    this._funnelingRoomNames = funnelingRoomNames
    return funnelingRoomNames
  }

  /**
   * Qualifying rooms either want to be funneled, or the room next in line to get funneled wants to be funneled.
   * Take a line where x means the rooms don't independently want to be funneled, and y means they do {x, x, y, y, x}.
   * This function will work from back to front so that if a previous room wants to be funneled, so will the proceeding one.
   * In this example, the set should convert to {y, y, y, y, x}
   */
  private getFunnelWanters(funnelOrder: string[]) {
    const funnelWanters = new Set<string>()
    let previousWantsToBeIndependentlyFunneled: boolean

    // Find what rooms want to get funneled

    for (let i = funnelOrder.length - 1; i >= 0; i -= 1) {
      const roomName = funnelOrder[i]
      const room = Game.rooms[roomName]

      const wantsToBeFunneledIndependent = communeUtils.wantsToBeFunneledIndependent(room)

      if (!(previousWantsToBeIndependentlyFunneled && wantsToBeFunneledIndependent)) {
        previousWantsToBeIndependentlyFunneled = false
      }

      previousWantsToBeIndependentlyFunneled = wantsToBeFunneledIndependent

      funnelWanters.add(roomName)
    }

    return funnelWanters
  }

  _resourcesInStoringStructures: Partial<{ [key in ResourceConstant]: number }>
  get resourcesInStoringStructures() {
    if (this._resourcesInStoringStructures) return this._resourcesInStoringStructures

    this._resourcesInStoringStructures = {}

    for (const roomName of collectiveManager.communes) {
      const room = Game.rooms[roomName]
      const resources = room.roomManager.resourcesInStoringStructures

      for (const key in resources) {
        const resource = key as unknown as ResourceConstant

        if (!this._resourcesInStoringStructures[resource]) {
          this._resourcesInStoringStructures[resource] = resources[resource]
          continue
        }

        this._resourcesInStoringStructures[resource] += resources[resource]
      }
    }

    return this._resourcesInStoringStructures
  }

  _maxCSitesPerRoom: number
  /**
   * The largest amount of construction sites we can try to have in a room
   */
  get maxCSitesPerRoom() {
    if (this._maxCSitesPerRoom) return this._maxCSitesPerRoom

    return Math.max(Math.min(MAX_CONSTRUCTION_SITES / collectiveManager.communes.size, 20), 3)
  }
}

export const collectiveManager = new CollectiveManager()

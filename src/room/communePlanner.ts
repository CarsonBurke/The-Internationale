import {
    CPUMaxPerTick,
    defaultRoadPlanningPlainCost,
    EXIT,
    maxRampartGroupSize,
    customColors,
    NORMAL,
    PROTECTED,
    roadUpkeepCost,
    roomDimensions,
    stamps,
    TO_EXIT,
    UNWALKABLE,
    RESULT_SUCCESS,
    RESULT_FAIL,
    cardinalOffsets,
    adjacentOffsets,
    RESULT_NO_ACTION,
    RESULT_ACTION,
    defaultMinCutDepth,
    minOnboardingRamparts,
    defaultSwampCost,
} from 'international/constants'
import {
    areCoordsEqual,
    createPosMap,
    customLog,
    findAdjacentCoordsToCoord,
    findAdjacentCoordsToXY,
    findAvgBetweenCoords,
    findClosestCoord,
    findClosestPos,
    findCoordsInRange,
    findCoordsInRangeXY,
    findCoordsInsideRect,
    forAdjacentCoords,
    forCoordsInRange,
    getRangeXY,
    getRange,
    isXYExit,
    isXYInBorder,
    isXYInRoom,
    packAsNum,
    packXYAsNum,
    unpackNumAsCoord,
    unpackNumAsPos,
} from 'international/utils'
import { internationalManager } from 'international/international'
import { packCoord, packPos, packPosList, packStampAnchors, packXYAsCoord, reversePosList, unpackCoord, unpackPosList, unpackStampAnchors } from 'other/codec'
import 'other/RoomVisual'
import { CommuneManager } from 'room/commune/commune'
import { rampartPlanner } from './construction/rampartPlanner'
import { RoomManager } from './room'
import { BasePlans } from './construction/basePlans'
import { RampartPlans } from './construction/rampartPlans'
import { minCutToExit } from './construction/minCut'

const unprotectedCoordWeight = defaultRoadPlanningPlainCost * 2
const dynamicDistanceWeight = 2

interface PlanStampsArgs {
    stampType: StampTypes
    count: number
    startCoords: Coord[]
    dynamic?: boolean
    weighted?: boolean
    diagonalDT?: boolean
    coordMap?: CoordMap
    minAvoid?: number
    cardinalFlood?: boolean
    /**
     * How to consider potential stampAnchors
     */
    conditions?(coord: Coord): boolean
    /**
     * What to do with the stampAnchor resulting from a successful individual plan
     * @param coord the stampAnchor
     */
    consequence(coord: Coord): void
}

interface FindDynamicStampAnchorArgs {
    stamp: Stamp
    startCoords: Coord[]
    minAvoid?: number
    conditions?(coord: Coord): boolean
}

interface FindDynamicStampAnchorWeightedArgs extends FindDynamicStampAnchorArgs {
    coordMap: CoordMap
}

interface FindStampAnchorArgs {
    stamp: Stamp
    startCoords: Coord[]
    coordMap: CoordMap
    minAvoid?: number
    cardinalFlood?: boolean
    conditions?(coord: Coord): boolean
}

/**
 *
 */
export class CommunePlanner {
    roomManager: RoomManager
    room: Room

    // Holistic

    planAttempts: BasePlanAttempt[]
    planVisualizeIndex: number
    terrainCoords: CoordMap


    //

    centerUpgradePos: RoomPosition
    upgradePath: RoomPosition[]

    inputLab2Coord: Coord
    outputLabCoords: Coord[]
    sourceHarvestPositions: RoomPosition[][]
    sourcePaths: RoomPosition[][]

    mineralPath: RoomPosition[]
    mineralHarvestPositions: RoomPosition[]

    unprotectedSources: number
    isControllerProtected: boolean

    // Action checks

    plannedGridCoords: boolean
    finishedGrid: boolean
    generalShielded: boolean
    finishedGridExtensionPaths: boolean
    finishedFastFillerRoadPrune: boolean
    /**
     * If the planner is in the process of recording a plan attempt
     */
    recording: boolean

    //

    basePlans: BasePlans
    rampartPlans: RampartPlans
    baseCoords: Uint8Array
    roadCoords: Uint8Array
    rampartCoords: Uint8Array
    weightedDiagonalCoords: Uint8Array
    diagonalCoords: Uint8Array
    gridCoords: Uint8Array
    exitCoords: Coord[]
    /**
     * Coords adjacent to exits, including exit coords
     */
    byExitCoords: Uint8Array
    /**
     * Coords adjacent to planned roads
     */
    byPlannedRoad: Uint8Array

    /**
     * Coords we should be protecting using ramparts
     */
    protectCoords: Set<string>
    /**
     * Coords protected by ramparts
     */
    protectedCoords: Uint8Array
    /**
     * Coords outside of rampart protection or in range of defensive combat areas
     */
    unprotectedCoords: Uint8Array
    stampAnchors: Partial<{ [key in StampTypes]: Coord[] }>
    fastFillerStartCoords: Coord[]
    minCutCoords: Set<number>
    groupedMinCutCoords: Coord[][]
    /**
     * The preference towards a plan attempt. Lower score is better
     */
    score: number

    constructor(roomManager: RoomManager) {
        this.roomManager = roomManager
    }

    _reverseExitFlood: Uint8Array
    get reverseExitFlood() {
        if (this._reverseExitFlood) return this._reverseExitFlood

        this._reverseExitFlood = new Uint8Array(2500)

        let visitedCoords = new Uint8Array(2500)
        for (const coord of this.exitCoords) visitedCoords[packAsNum(coord)] = 1

        let depth = 1
        let thisGeneration = this.exitCoords
        let nextGeneration: Coord[]

        while (thisGeneration.length) {
            nextGeneration = []

            // Iterate through positions of this gen

            for (const coord1 of thisGeneration) {
                this._reverseExitFlood[packAsNum(coord1)] = 255 - depth

                // Add viable adjacent coords to the next generation

                for (const offset of adjacentOffsets) {
                    const coord2 = {
                        x: coord1.x + offset.x,
                        y: coord1.y + offset.y,
                    }

                    if (!isXYInRoom(coord2.x, coord2.y)) continue

                    if (visitedCoords[packAsNum(coord2)] === 1) continue
                    visitedCoords[packAsNum(coord2)] = 1

                    if (this.terrainCoords[packAsNum(coord2)] === 255) continue

                    nextGeneration.push(coord2)
                }
            }

            // Set up for next generation

            depth += 1
            thisGeneration = nextGeneration
        }

        return this._reverseExitFlood
    }

    preTickRun() {

        this.room = this.roomManager.room
        if (this.room.memory.PC !== undefined) return RESULT_NO_ACTION

        // Stop if there isn't sufficient CPU

        if (Game.cpu.bucket < CPUMaxPerTick) return RESULT_NO_ACTION

        if (this.recording) this.record()

        // Planning is complete, choose the best one
        customLog('PLAN ATTEMPTS', this.planAttempts?.length)
        customLog('FASTFILLER ORIGINS', this.fastFillerStartCoords?.length)
        if (this.fastFillerStartCoords && this.planAttempts.length === this.fastFillerStartCoords.length) {

            this.visualizeBestPlan()
            /* this.choosePlan() */
            return RESULT_SUCCESS
        }

        // Initial configuration

        if (!this.terrainCoords) {
            this.terrainCoords = internationalManager.getTerrainCoords(this.room.name)
            this.planAttempts = []
        }

        // Plan attempt / configuration

        if (!this.baseCoords) {
            this.baseCoords = new Uint8Array(this.terrainCoords)
            this.roadCoords = new Uint8Array(this.terrainCoords)
            this.rampartCoords = new Uint8Array(2500)
            this.byPlannedRoad = new Uint8Array(2500)

            this.byExitCoords = new Uint8Array(2500)
            this.exitCoords = []
            this.recordExits()

            this.basePlans = new BasePlans()
            this.rampartPlans = new RampartPlans()
            this.stampAnchors = {}
            for (const stampType in stamps) this.stampAnchors[stampType as StampTypes] = []
            this.score = 0
        }

        this.avoidSources()
        this.fastFiller()
        this.generateGrid()
        this.pruneFastFillerRoads()
        this.findCenterUpgradePos()
        this.preHubSources()
        this.hub()
        this.mineral()
        this.preLabSources()
        this.labs()
        this.gridExtensions()
        this.gridExtensionPaths()
        this.nuker()
        this.powerSpawn()
        this.observer()
        this.planGridCoords()
        this.planMineralStructure()
        this.planSourceStructures()
        this.runMinCut()
        this.towers()
        this.groupMinCutCoords()
        this.findUnprotectedCoords()
        this.onboardingRamparts()
        this.generalShield()
        this.findScore()
        /* this.visualizeCurrentPlan() */
        /* this.visualizeGrid() */

        this.record()

        return RESULT_SUCCESS
    }
    private recordExits() {
        for (const packedCoord of this.room.exitCoords) {
            const coord = unpackCoord(packedCoord)
            this.exitCoords.push(coord)
            forAdjacentCoords(coord, adjCoord => {
                const packedAdjCoord = packAsNum(adjCoord)
                if (this.terrainCoords[packedAdjCoord] === 255) return

                this.byExitCoords[packedAdjCoord] = 255
                this.baseCoords[packedAdjCoord] = 255
            })
        }
    }
    private generateGrid() {
        if (this.finishedGrid) return

        delete this.gridCoords
        delete this.diagonalCoords
        delete this.weightedDiagonalCoords

        const terrain = this.room.getTerrain()
        const gridSize = 4
        const anchor = new RoomPosition(
            this.stampAnchors.fastFiller[0].x,
            this.stampAnchors.fastFiller[0].y - 1,
            this.room.name,
        )

        const inset = 1

        this.diagonalCoords = new Uint8Array(2500)
        this.weightedDiagonalCoords = new Uint8Array(2500)

        // Checkerboard

        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                if (this.terrainCoords[packXYAsNum(x, y)] === 255) continue

                // Calculate the position of the cell relative to the anchor

                const relX = x - anchor.x
                const relY = y - anchor.y

                // Check if the cell is part of a diagonal line
                if (
                    Math.abs(relX - 3 * relY) % (gridSize / 2) !== 0 &&
                    Math.abs(relX + 3 * relY) % (gridSize / 2) !== 0
                )
                    continue

                const packedCoord = packXYAsNum(x, y)

                if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
                    this.diagonalCoords[packedCoord] = 3 * defaultSwampCost
                    this.weightedDiagonalCoords[packedCoord] = 8 * defaultSwampCost
                    continue
                }
                this.diagonalCoords[packedCoord] = 4
                this.weightedDiagonalCoords[packedCoord] = 8
            }
        }

        this.gridCoords = new Uint8Array(2500)
        const gridCoordsArray: Coord[] = []

        // Grid

        for (let x = inset; x < roomDimensions - inset; x++) {
            for (let y = inset; y < roomDimensions - inset; y++) {
                const packedCoord = packXYAsNum(x, y)
                if (this.baseCoords[packedCoord] === 255) continue
                if (this.byExitCoords[packedCoord] > 0) continue

                // Calculate the position of the cell relative to the anchor

                const relX = x - anchor.x
                const relY = y - anchor.y

                // Check if the cell is part of a diagonal line
                if (Math.abs(relX - 3 * relY) % gridSize !== 0 && Math.abs(relX + 3 * relY) % gridSize !== 0) continue

                gridCoordsArray.push({ x, y })

                if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
                    this.gridCoords[packedCoord] = 2 * defaultSwampCost
                    continue
                }
                this.gridCoords[packedCoord] = 2
            }
        }

        // Group grid coords

        const gridGroups: Coord[][] = []
        let visitedCoords: Set<string> = new Set()
        let groupIndex = 0

        for (const gridCoord of gridCoordsArray) {
            const packedCoord = packCoord(gridCoord)
            if (visitedCoords.has(packedCoord)) continue

            visitedCoords.add(packedCoord)

            gridGroups[groupIndex] = [gridCoord]

            let thisGeneration = [gridCoord]
            let nextGeneration: Coord[]
            let groupSize = 0

            while (thisGeneration.length) {
                nextGeneration = []

                for (const coord of thisGeneration) {
                    for (const adjCoord of findAdjacentCoordsToCoord(coord)) {
                        const packedAdjCoord = packCoord(adjCoord)
                        if (visitedCoords.has(packedAdjCoord)) continue

                        visitedCoords.add(packedAdjCoord)

                        if (this.gridCoords[packAsNum(adjCoord)] === 0) continue

                        // Calculate the position of the cell relative to the anchor

                        const relX = adjCoord.x - anchor.x
                        const relY = adjCoord.y - anchor.y

                        // Check if the cell is part of a diagonal line
                        if (Math.abs(relX - 3 * relY) % gridSize !== 0 && Math.abs(relX + 3 * relY) % gridSize !== 0)
                            continue

                        groupSize += 1
                        gridGroups[groupIndex].push(adjCoord)
                        nextGeneration.push(adjCoord)
                    }
                }

                if (groupSize > 20) break
                thisGeneration = nextGeneration
            }

            groupIndex += 1
        }

        // Get group leaders

        interface SpecialCoord extends Coord {
            index: number
        }

        const groupLeaders: SpecialCoord[] = []

        for (let i = 0; i < gridGroups.length; i++) {
            const coord = gridGroups[i][0] as SpecialCoord

            coord.index = i
            groupLeaders.push(coord)
        }

        // Sort by closer to anchor

        groupLeaders.sort((a, b) => {
            return getRange(a, anchor) - getRange(b, anchor)
        })

        // Paths for grid groups

        for (const leaderCoord of groupLeaders) {
            const path = this.room.advancedFindPath({
                origin: new RoomPosition(leaderCoord.x, leaderCoord.y, this.room.name),
                goals: [{ pos: anchor, range: 3 }],
                weightCoordMaps: [this.weightedDiagonalCoords, this.gridCoords, this.baseCoords],
                plainCost: defaultRoadPlanningPlainCost * 6,
                swampCost: defaultSwampCost * 6,
            })

            // If the path failed, delete all members of the group

            if (!path.length) {
                for (const coord of gridGroups[leaderCoord.index]) {
                    this.gridCoords[packAsNum(coord)] = 0
                }
                continue
            }

            for (const coord of path) {
                if (terrain.get(coord.x, coord.y) === TERRAIN_MASK_SWAMP) {
                    this.gridCoords[packAsNum(coord)] = 2 * defaultSwampCost
                    continue
                }
                this.gridCoords[packAsNum(coord)] = 2
            }
        }

        // Group exits

        const exitGroups: Coord[][] = []
        visitedCoords = new Set()
        groupIndex = 0

        for (const packedCoord of this.room.exitCoords) {
            const exitCoord = unpackCoord(packedCoord)
            if (visitedCoords.has(packedCoord)) continue

            visitedCoords.add(packedCoord)

            exitGroups[groupIndex] = [exitCoord]

            let thisGeneration = [exitCoord]
            let nextGeneration: Coord[]
            let groupSize = 0

            while (thisGeneration.length) {
                nextGeneration = []

                for (const coord of thisGeneration) {
                    for (const adjCoord of findAdjacentCoordsToCoord(coord)) {
                        if (!isXYExit(adjCoord.x, adjCoord.y)) continue
                        if (this.terrainCoords[packAsNum(adjCoord)] === 255) continue

                        const packedAdjCoord = packCoord(adjCoord)
                        if (visitedCoords.has(packedAdjCoord)) continue

                        visitedCoords.add(packedAdjCoord)

                        groupSize += 1
                        exitGroups[groupIndex].push(adjCoord)
                        nextGeneration.push(adjCoord)
                    }
                }

                if (groupSize > 10) break
                thisGeneration = nextGeneration
            }

            groupIndex += 1
        }

        // Paths for exit groups

        for (const group of exitGroups) {
            const path = this.room.advancedFindPath({
                origin: new RoomPosition(group[0].x, group[0].y, this.room.name),
                goals: [{ pos: anchor, range: 3 }],
                weightCoordMaps: [this.weightedDiagonalCoords, this.gridCoords],
                plainCost: defaultRoadPlanningPlainCost * 6,
                swampCost: defaultSwampCost * 6,
            })

            for (const coord of path) {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) continue

                if (terrain.get(coord.x, coord.y) === TERRAIN_MASK_SWAMP) {
                    this.gridCoords[packAsNum(coord)] = 2 * defaultSwampCost
                    continue
                }
                this.gridCoords[packAsNum(coord)] = 2
            }
        }

        this.pruneGridCoords()

        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                const packedCoord = packXYAsNum(x, y)
                if (this.gridCoords[packedCoord] === 0) continue

                for (const adjCoord of findAdjacentCoordsToXY(x, y)) {
                    const packedAdjCoord = packAsNum(adjCoord)

                    if (this.gridCoords[packedAdjCoord] > 0) continue
                    if (this.terrainCoords[packedAdjCoord] === 255) continue

                    this.byPlannedRoad[packedAdjCoord] = 1
                }
            }
        }

        this.finishedGrid = true
    }
    private pruneGridCoords() {
        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                this.pruneGridXY(x, y)
            }
        }
    }
    private pruneGridXY(x: number, y: number) {
        const packedCoord = packXYAsNum(x, y)
        if (this.gridCoords[packedCoord] === 0) return

        let adjNonGridCoords: Coord[] = []
        let adjGridCoords = 0

        for (const adjCoord of findAdjacentCoordsToXY(x, y)) {
            const packedAdjCoord = packAsNum(adjCoord)

            if (this.gridCoords[packedAdjCoord] > 0) {
                adjGridCoords += 1
                continue
            }

            if (this.terrainCoords[packedAdjCoord] === 255) continue

            adjNonGridCoords.push(adjCoord)
        }

        if (adjGridCoords > 1) return

        // No reason to keep a coord that does nothing

        if (adjNonGridCoords.length <= 1) {
            this.gridCoords[packedCoord] = 0
            return
        }

        let noAltNonGridCoord: boolean

        for (const adjNonGridCoord of adjNonGridCoords) {
            adjGridCoords = 0

            for (const adjCoord of findAdjacentCoordsToCoord(adjNonGridCoord)) {
                if (this.gridCoords[packAsNum(adjCoord)] === 0) continue

                adjGridCoords += 1
            }

            if (adjGridCoords > 1) continue
            if (noAltNonGridCoord) return

            noAltNonGridCoord = true
        }

        this.gridCoords[packedCoord] = 0
    }
    private pruneFastFillerRoads() {
        if (this.finishedFastFillerRoadPrune) return

        const anchor = this.stampAnchors.fastFiller[0]

        const rectCoords = findCoordsInsideRect(
            anchor.x - stamps.fastFiller.offset,
            anchor.y - stamps.fastFiller.offset,
            anchor.x + stamps.fastFiller.offset,
            anchor.y + stamps.fastFiller.offset,
        )

        for (const coord of rectCoords) {
            const packedCoordNum = packAsNum(coord)
            if (this.roadCoords[packedCoordNum] !== 1) continue

            if (this.fastFillerPruneRoadCoord(coord) === RESULT_ACTION) {
                this.roadCoords[packedCoordNum] = 0
                continue
            }

            this.basePlans.set(packCoord(coord), STRUCTURE_ROAD, 3)
            this.roadCoords[packedCoordNum] = 1
            this.byPlannedRoad[packedCoordNum] = 0
        }

        this.finishedFastFillerRoadPrune = true
    }
    private avoidSources() {
        if (this.sourceHarvestPositions) return

        const sourceHarvestPositions: RoomPosition[][] = []

        let i = -1
        for (const source of this.room.sources) {
            i += 1
            sourceHarvestPositions.push([])

            for (const offset of adjacentOffsets) {
                const adjPos = new RoomPosition(offset.x + source.pos.x, offset.y + source.pos.y, this.room.name)

                const packedCoord = packAsNum(adjPos)
                if (this.terrainCoords[packedCoord] === 255) continue

                this.baseCoords[packedCoord] = 255
                sourceHarvestPositions[i].push(adjPos)
            }
        }

        this.sourceHarvestPositions = sourceHarvestPositions
    }
    private postFastFillerConfig() {
        for (let i = 0; i < this.sourceHarvestPositions.length; i++) {
            for (const pos of this.sourceHarvestPositions[i]) {
                this.baseCoords[packAsNum(pos)] = 0
            }
        }

        for (const coord of findCoordsInRange(this.room.controller.pos, 2)) {
            const packedCoord = packAsNum(coord)
            this.baseCoords[packedCoord] = this.terrainCoords[packedCoord]
        }
    }
    private preHubSources() {
        if (this.sourcePaths) return

        const fastFillerAnchor = new RoomPosition(
            this.stampAnchors.fastFiller[0].x,
            this.stampAnchors.fastFiller[0].y,
            this.room.name,
        )
        const sourcePaths: RoomPosition[][] = []

        for (let i = this.sourceHarvestPositions.length - 1; i >= 0; i -= 1) {
            // Remove source harvest positions overlapping with upgrade positions or other source harvest positions
            // Loop through each pos index

            for (let j = this.sourceHarvestPositions[i].length - 1; j >= 0; j -= 1) {
                if (this.baseCoords[packAsNum(this.sourceHarvestPositions[i][j])] !== 255) continue

                this.sourceHarvestPositions.splice(j, 1)
            }

            this.sourceHarvestPositions[i].sort((a, b) => {
                return (
                    this.room.advancedFindPath({
                        origin: a,
                        goals: [
                            {
                                pos: fastFillerAnchor,
                                range: 3,
                            },
                        ],
                        weightCoordMaps: [this.gridCoords, this.roadCoords],
                        plainCost: defaultRoadPlanningPlainCost,
                    }).length -
                    this.room.advancedFindPath({
                        origin: b,
                        goals: [
                            {
                                pos: fastFillerAnchor,
                                range: 3,
                            },
                        ],
                        weightCoordMaps: [this.gridCoords, this.roadCoords],
                        plainCost: defaultRoadPlanningPlainCost,
                    }).length
                )
            })

            const closestHarvestPos = this.sourceHarvestPositions[i][0]

            this.basePlans.set(packCoord(closestHarvestPos), STRUCTURE_CONTAINER, 3)
            const packedCoord = packAsNum(closestHarvestPos)
            this.roadCoords[packedCoord] = 20
            this.baseCoords[packedCoord] = 20

            const path = this.room.advancedFindPath({
                origin: closestHarvestPos,
                goals: [
                    {
                        pos: fastFillerAnchor,
                        range: 3,
                    },
                ],
                weightCoordMaps: [this.diagonalCoords, this.gridCoords, this.roadCoords],
                plainCost: defaultRoadPlanningPlainCost * 2,
                swampCost: defaultSwampCost * 2,
            })
            sourcePaths.push(path)

            for (const pos of path) {
                this.basePlans.set(packCoord(pos), STRUCTURE_ROAD, 3)
                this.roadCoords[packAsNum(pos)] = 1
            }
        }

        this.sourcePaths = sourcePaths
    }
    private mineral() {
        if (this.mineralPath) return

        const goal = new RoomPosition(this.stampAnchors.hub[0].x, this.stampAnchors.hub[0].y, this.room.name)

        const mineralPath = this.room.advancedFindPath({
            origin: this.room.mineral.pos,
            goals: [{ pos: goal, range: 1 }],
            weightCoordMaps: [this.diagonalCoords, this.gridCoords, this.roadCoords],
            plainCost: defaultRoadPlanningPlainCost * 2,
            swampCost: defaultSwampCost * 2,
        })

        this.mineralHarvestPositions = [mineralPath[0]]
        mineralPath.shift()

        forAdjacentCoords(this.room.mineral.pos, adjCoord => {
            if (this.baseCoords[packAsNum(adjCoord)] === 255) return
            if (getRange(mineralPath[0], adjCoord) > 1) return

            this.mineralHarvestPositions.push(new RoomPosition(adjCoord.x, adjCoord.y, this.room.name))
        })

        for (const pos of this.mineralHarvestPositions) {
            const packedCoord = packAsNum(pos)
            this.roadCoords[packedCoord] = 20
            this.baseCoords[packedCoord] = 255
        }

        for (const pos of mineralPath) {
            const packedCoord = packAsNum(pos)
            this.roadCoords[packedCoord] = 1
            this.basePlans.setXY(pos.x, pos.y, STRUCTURE_ROAD, 6)
        }

        this.mineralPath = mineralPath
    }
    private preLabSources() {
        if (this.stampAnchors.sourceLink.length) return

        const hubAnchor = this.stampAnchors.hub[0]
        const sourceLinkCoords: Coord[] = []
        const sourceExtensionCoords: Coord[] = []

        for (let i = 0; i < this.sourceHarvestPositions.length; i++) {
            const closestHarvestPos = this.sourceHarvestPositions[i][0]
            const packedAdjCoords: Set<number> = new Set([])
            let closestAdjCoord: Coord
            let closestRange = Infinity

            for (const offset of adjacentOffsets) {
                const adjCoord = {
                    x: closestHarvestPos.x + offset.x,
                    y: closestHarvestPos.y + offset.y,
                }

                const packedCoord = packAsNum(adjCoord)
                if (this.baseCoords[packedCoord] === 255) continue
                if (this.roadCoords[packedCoord] > 0) continue
                /* if (this.gridCoords[packedCoord] > 0) continue */

                packedAdjCoords.add(packAsNum(adjCoord))

                const range = getRange(hubAnchor, adjCoord)
                if (range >= closestRange) continue

                closestAdjCoord = adjCoord
                closestRange = range
            }

            const packedClosestAdjCoord = packAsNum(closestAdjCoord)
            packedAdjCoords.delete(packedClosestAdjCoord)

            sourceLinkCoords.push(closestAdjCoord)
            this.baseCoords[packedClosestAdjCoord] = 255
            this.roadCoords[packedClosestAdjCoord] = 255

            for (const packedAdjCoord of packedAdjCoords) {
                sourceExtensionCoords.push(unpackNumAsCoord(packedAdjCoord))
                this.baseCoords[packedAdjCoord] = 255
                this.roadCoords[packedAdjCoord] = 255
            }
        }

        this.stampAnchors.sourceLink = sourceLinkCoords
        this.stampAnchors.sourceExtension = sourceExtensionCoords
    }
    private planMineralStructure() {
        const mineralPos = this.room.mineral.pos
        this.basePlans.setXY(mineralPos.x, mineralPos.y, STRUCTURE_EXTRACTOR, 6)

        const bestMineralHarvestPos = this.mineralHarvestPositions[0]
        this.basePlans.setXY(bestMineralHarvestPos.x, bestMineralHarvestPos.y, STRUCTURE_CONTAINER, 6)
    }
    private planSourceStructures() {
        for (const coord of this.stampAnchors.sourceLink) {
            this.basePlans.set(packCoord(coord), STRUCTURE_LINK, 6)
        }

        for (const coord of this.stampAnchors.sourceExtension) {
            this.basePlans.set(packCoord(coord), STRUCTURE_EXTENSION, 7)
        }
    }
    private findCenterUpgradePos() {
        if (this.centerUpgradePos) return false
        const controllerPos = this.room.controller.pos

        // Get the open areas in a range of 3 to the controller

        const distanceCoords = this.room.distanceTransform(
            this.roadCoords,
            false,
            1,
            controllerPos.x - 2,
            controllerPos.y - 2,
            controllerPos.x + 2,
            controllerPos.y + 2,
        )

        // Find the closest value greater than two to the centerUpgradePos and inform it

        const centerUpgradePos = this.room.findClosestPosOfValue({
            coordMap: distanceCoords,
            startCoords: [this.stampAnchors.fastFiller[0]],
            requiredValue: 2,
            reduceIterations: 1,
            visuals: false,
            cardinalFlood: true,
        })
        if (!centerUpgradePos) return false

        const packedCoord = packAsNum(centerUpgradePos)
        this.roadCoords[packedCoord] = 20
        this.baseCoords[packedCoord] = 255
        this.basePlans.set(packCoord(centerUpgradePos), STRUCTURE_CONTAINER, 2)
        this.basePlans.set(packCoord(centerUpgradePos), STRUCTURE_LINK, 5)

        const path = this.room.advancedFindPath({
            origin: centerUpgradePos,
            goals: [
                {
                    pos: new RoomPosition(
                        this.stampAnchors.fastFiller[0].x,
                        this.stampAnchors.fastFiller[0].y,
                        this.room.name,
                    ),
                    range: 3,
                },
            ],
            weightCoordMaps: [this.diagonalCoords, this.gridCoords, this.roadCoords],
            plainCost: defaultRoadPlanningPlainCost * 2,
            swampCost: defaultSwampCost * 2,
        })

        for (const offset of adjacentOffsets) {
            const adjCoord = {
                x: offset.x + centerUpgradePos.x,
                y: offset.y + centerUpgradePos.y,
            }

            const packedAdjCoord = packAsNum(adjCoord)
            this.baseCoords[packedAdjCoord] = 255
            this.roadCoords[packedAdjCoord] = 20
        }

        for (const pos of path) {
            const packedPathCoord = packAsNum(pos)
            this.roadCoords[packedPathCoord] = 1
            this.basePlans.set(packCoord(pos), STRUCTURE_ROAD, 3)
        }

        this.upgradePath = path
        return (this.centerUpgradePos = centerUpgradePos)
    }
    /**
     *
     * @param coord
     * @returns RESULT_ACTION if the road should be removed
     */
    private fastFillerPruneRoadCoord(coord: Coord) {
        let adjSpawn: boolean

        for (const offset of adjacentOffsets) {
            const adjCoord = {
                x: offset.x + coord.x,
                y: offset.y + coord.y,
            }

            const packedAdjCoord = packAsNum(adjCoord)
            if (this.terrainCoords[packedAdjCoord] === 255) continue
            if (this.roadCoords[packedAdjCoord] !== 1 && this.gridCoords[packedAdjCoord] === 0)
                this.byPlannedRoad[packedAdjCoord] = 1

            if (this.basePlans.get(packCoord(adjCoord))?.structureType === STRUCTURE_SPAWN) adjSpawn = true
        }

        if (adjSpawn) return RESULT_NO_ACTION

        let cardinalRoads = 0

        for (const offset of cardinalOffsets) {
            const adjCoord = {
                x: offset.x + coord.x,
                y: offset.y + coord.y,
            }

            const packedAdjCoord = packAsNum(adjCoord)
            if (this.roadCoords[packedAdjCoord] !== 1 && this.gridCoords[packedAdjCoord] === 0) continue

            cardinalRoads += 1
        }

        if (cardinalRoads >= 3) return RESULT_ACTION
        return RESULT_NO_ACTION
    }
    private planGridCoords() {
        if (this.plannedGridCoords) return

        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                const packedCoord = packXYAsNum(x, y)
                if (this.gridCoords[packedCoord] === 0) continue
                if (this.roadCoords[packedCoord] === 1) continue
                if (this.baseCoords[packedCoord] === 255) continue

                let hasNeed

                for (const offset of adjacentOffsets) {
                    const adjCoord = {
                        x: offset.x + x,
                        y: offset.y + y,
                    }

                    const plan = this.basePlans.get(packCoord(adjCoord))
                    if (!plan) continue
                    if (plan.structureType === STRUCTURE_ROAD) continue

                    hasNeed = true
                    break
                }

                if (!hasNeed) continue

                this.basePlans.setXY(x, y, STRUCTURE_ROAD, 3)
                this.roadCoords[packedCoord] = 1
            }
        }

        this.plannedGridCoords = true
    }
    private flipStructuresVertical(stamp: Stamp) {
        const flippedStructures: Partial<{ [key in StructureConstant]: Coord[] }> = {}

        for (const structureType in stamp.structures) {
            const coords = stamp.structures[structureType]
            flippedStructures[structureType as StructureConstant] = coords.map(coord => ({
                x: coord.x,
                y: stamp.size + stamp.offset - coord.y - 1,
            }))
        }

        return flippedStructures
    }

    private flipStructuresHorizontal(stamp: Stamp) {
        const flippedStructures: Partial<{ [key in StructureConstant]: Coord[] }> = {}

        for (const structureType in stamp.structures) {
            const coords = stamp.structures[structureType]
            flippedStructures[structureType as StructureConstant] = coords.map(coord => ({
                x: stamp.size + stamp.offset - coord.x - 1,
                y: coord.y,
            }))
        }

        return flippedStructures
    }
    private planStamps(args: PlanStampsArgs) {
        if (!args.coordMap) args.coordMap = this.baseCoords

        const stamp = stamps[args.stampType]

        args.count -= this.stampAnchors[args.stampType].length

        for (; args.count > 0; args.count -= 1) {
            let stampAnchor: Coord | false

            if (args.dynamic) {
                if (args.weighted) {
                    stampAnchor = this.findDynamicStampAnchorWeighted({
                        stamp,
                        startCoords: args.startCoords,
                        conditions: args.conditions,
                        coordMap: args.coordMap,
                    })
                    if (!stampAnchor) continue

                    args.consequence(stampAnchor)
                    this.stampAnchors[args.stampType].push(stampAnchor)

                    continue
                }
                stampAnchor = this.findDynamicStampAnchor({
                    stamp,
                    startCoords: args.startCoords,
                    conditions: args.conditions,
                })
                if (!stampAnchor) continue

                args.consequence(stampAnchor)
                this.stampAnchors[args.stampType].push(stampAnchor)

                continue
            }

            // Not dynamic

            // Run distance transform with the baseCM

            const distanceCoords = args.diagonalDT
                ? this.room.diagonalDistanceTransform(args.coordMap, false, args.minAvoid)
                : this.room.distanceTransform(args.coordMap, false, args.minAvoid)

            stampAnchor = this.findStampAnchor({
                stamp,
                startCoords: args.startCoords,
                cardinalFlood: args.cardinalFlood,
                coordMap: distanceCoords,
            })
            if (!stampAnchor) continue

            args.consequence(stampAnchor)
            this.stampAnchors[args.stampType].push(stampAnchor)
        }
    }
    private recordStamp(stampType: StampTypes, stampAnchor: Coord) {
        const stamp = stamps[stampType]

        for (const key in stamp.structures) {
            const structureType = key as StructureConstant
            if (!stamp.structures[structureType]) continue

            for (const coordOffset of stamp.structures[structureType]) {
                const coord = {
                    x: coordOffset.x + stampAnchor.x - stamp.offset,
                    y: coordOffset.y + stampAnchor.y - stamp.offset,
                }

                this.basePlans.set(packCoord(coord), structureType, 8)

                const packedCoord = packAsNum(coord)

                if (structureType === STRUCTURE_ROAD) {
                    this.roadCoords[packedCoord] = 1
                    continue
                }

                this.baseCoords[packedCoord] = 255
                this.roadCoords[packedCoord] = 255
            }
        }
    }
    private findStampAnchor(args: FindStampAnchorArgs) {
        let visitedCoords = new Uint8Array(2500)
        for (const coord of args.startCoords) visitedCoords[packAsNum(coord)] = 1

        let thisGeneration = args.startCoords
        let nextGeneration: Coord[]

        while (thisGeneration.length) {
            nextGeneration = []

            let localVisitedCoords = new Uint8Array(visitedCoords)

            // Flood cardinal directions, excluding impassibles

            if (args.cardinalFlood) {
                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    if (this.isViableStampAnchor(args, coord1)) return coord1

                    // Add viable adjacent coords to the next generation

                    for (const offset of cardinalOffsets) {
                        const coord2 = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }

                        if (!isXYInRoom(coord2.x, coord2.y)) continue

                        if (localVisitedCoords[packAsNum(coord2)] === 1) continue
                        localVisitedCoords[packAsNum(coord2)] = 1

                        if (args.coordMap[packAsNum(coord2)] === 0) continue

                        nextGeneration.push(coord2)
                    }
                }
            }

            // Flood all adjacent positions

            if (!nextGeneration.length) {
                localVisitedCoords = new Uint8Array(visitedCoords)

                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    if (this.isViableStampAnchor(args, coord1)) return coord1

                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const coord2 = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }

                        if (!isXYInRoom(coord2.x, coord2.y)) continue

                        if (localVisitedCoords[packAsNum(coord2)] === 1) continue
                        localVisitedCoords[packAsNum(coord2)] = 1

                        if (args.coordMap[packAsNum(coord2)] === 0) continue

                        nextGeneration.push(coord2)
                    }
                }
            }

            // Flood all adjacent positions, including diagonals

            if (!nextGeneration.length) {
                localVisitedCoords = new Uint8Array(visitedCoords)

                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    if (this.isViableStampAnchor(args, coord1)) return coord1

                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const coord2 = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }

                        if (!isXYInRoom(coord2.x, coord2.y)) continue

                        if (localVisitedCoords[packAsNum(coord2)] === 1) continue
                        localVisitedCoords[packAsNum(coord2)] = 1

                        nextGeneration.push(coord2)
                    }
                }
            }

            // Set this gen to next gen

            visitedCoords = new Uint8Array(localVisitedCoords)
            thisGeneration = nextGeneration
        }

        // No stampAnchor was found

        return false
    }
    private isViableStampAnchor(args: FindStampAnchorArgs, coord1: Coord) {
        // Get the value of the pos

        const posValue = args.coordMap[packAsNum(coord1)]
        if (posValue === 255) return false
        if (posValue === 0) return false
        if (posValue < args.stamp.size) return false
        if (this.isCloseToExit(coord1, args.stamp.protectionOffset + 1)) return false
        return true
    }
    private findDynamicStampAnchor(args: FindDynamicStampAnchorArgs) {
        let visitedCoords = new Uint8Array(2500)
        for (const coord of args.startCoords) visitedCoords[packAsNum(coord)] = 1

        let thisGeneration = args.startCoords
        let nextGeneration: Coord[]

        while (thisGeneration.length) {
            nextGeneration = []

            let localVisitedCoords = new Uint8Array(visitedCoords)

            // Flood all adjacent positions

            if (!nextGeneration.length) {
                localVisitedCoords = new Uint8Array(visitedCoords)

                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    if (this.isViableDynamicStampAnchor(args, coord1)) return coord1

                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const coord2 = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }

                        if (!isXYInRoom(coord2.x, coord2.y)) continue

                        if (localVisitedCoords[packAsNum(coord2)] === 1) continue
                        localVisitedCoords[packAsNum(coord2)] = 1

                        if (this.baseCoords[packAsNum(coord2)] === 255) continue

                        nextGeneration.push(coord2)
                    }
                }
            }

            // Flood all adjacent positions, including diagonals

            if (!nextGeneration.length) {
                localVisitedCoords = new Uint8Array(visitedCoords)

                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    if (this.isViableDynamicStampAnchor(args, coord1)) return coord1

                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const coord2 = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }

                        if (!isXYInRoom(coord2.x, coord2.y)) continue

                        if (localVisitedCoords[packAsNum(coord2)] === 1) continue
                        localVisitedCoords[packAsNum(coord2)] = 1

                        nextGeneration.push(coord2)
                    }
                }
            }

            // Set this gen to next gen

            visitedCoords = new Uint8Array(localVisitedCoords)
            thisGeneration = nextGeneration
        }

        // No stampAnchor was found

        return false
    }
    private findDynamicStampAnchorWeighted(args: FindDynamicStampAnchorWeightedArgs) {
        let visitedCoords = new Uint8Array(2500)
        for (const coord of args.startCoords) visitedCoords[packAsNum(coord)] = 1

        let fromOrigin = new Uint8Array(2500)
        let lowestNextGenCost = Infinity
        let thisGeneration = args.startCoords
        let nextGeneration: Coord[]

        while (thisGeneration.length) {
            nextGeneration = []
            let lowestGenCost = lowestNextGenCost
            lowestNextGenCost = Infinity

            let localVisitedCoords = new Uint8Array(visitedCoords)

            // Flood adjacent coords that are passible

            for (const coord of thisGeneration) {
                const packedCoord = packAsNum(coord)
                const coordCostFromOrigin = fromOrigin[packedCoord]
                const coordCost = args.coordMap[packedCoord] + coordCostFromOrigin

                if (coordCost > lowestGenCost) {
                    nextGeneration.push(coord)
                    continue
                }

                if (this.isViableDynamicStampAnchor(args, coord)) return coord

                // Add viable adjacent coords to the next generation

                for (const offset of adjacentOffsets) {
                    const adjCoord = {
                        x: coord.x + offset.x,
                        y: coord.y + offset.y,
                    }

                    if (!isXYInRoom(coord.x, coord.y)) continue

                    const packedAdjCoord = packAsNum(adjCoord)

                    if (localVisitedCoords[packedAdjCoord] === 1) continue
                    localVisitedCoords[packedAdjCoord] = 1

                    if (this.baseCoords[packedAdjCoord] === 255) continue

                    nextGeneration.push(adjCoord)

                    const adjCostFromOrigin = (fromOrigin[packedAdjCoord] = coordCostFromOrigin + dynamicDistanceWeight)
                    const adjCoordCost = args.coordMap[packedAdjCoord] + adjCostFromOrigin

                    if (adjCoordCost < lowestNextGenCost) lowestNextGenCost = adjCoordCost
                }
            }

            // Flood all adjacent coords

            if (!nextGeneration.length) {
                localVisitedCoords = new Uint8Array(visitedCoords)

                for (const coord of thisGeneration) {
                    const packedCoord = packAsNum(coord)
                    const coordCostFromOrigin = fromOrigin[packedCoord]
                    const coordCost = args.coordMap[packedCoord] + coordCostFromOrigin

                    if (coordCost > lowestGenCost) {
                        nextGeneration.push(coord)
                        continue
                    }

                    if (this.isViableDynamicStampAnchor(args, coord)) return coord

                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const adjCoord = {
                            x: coord.x + offset.x,
                            y: coord.y + offset.y,
                        }

                        if (!isXYInRoom(coord.x, coord.y)) continue

                        const packedAdjCoord = packAsNum(adjCoord)

                        if (localVisitedCoords[packedAdjCoord] === 1) continue
                        localVisitedCoords[packedAdjCoord] = 1

                        nextGeneration.push(adjCoord)

                        const adjCostFromOrigin = (fromOrigin[packedAdjCoord] = coordCostFromOrigin + dynamicDistanceWeight)
                        const adjCoordCost = args.coordMap[packedAdjCoord] + adjCostFromOrigin

                        if (adjCoordCost < lowestNextGenCost) lowestNextGenCost = adjCoordCost
                    }
                }
            }

            // Set this gen to next gen

            visitedCoords = new Uint8Array(localVisitedCoords)
            thisGeneration = nextGeneration
        }

        // No stampAnchor was found

        return false
    }
    private isViableDynamicStampAnchor(args: FindDynamicStampAnchorArgs, coord1: Coord) {
        // Get the value of the pos
        /* this.room.visual.rect(coord1.x - 0.5, coord1.y - 0.5, 1, 1, { fill: customColors.red }) */
        if (this.baseCoords[packAsNum(coord1)] === 255) return false
        if (this.roadCoords[packAsNum(coord1)] > 0) return false
        if (this.isCloseToExit(coord1, args.stamp.protectionOffset + 2)) return false
        if (!args.conditions(coord1)) return false

        return true
    }
    /**
     * Finds wether the coord is in a specified range to an exit, flooding while avoiding walls
     * @param startCoord The string coordinate
     * @param range The max number of generations to do
     */
    private isCloseToExit(startCoord: Coord, range: number) {
        let visitedCoords = new Uint8Array(2500)
        visitedCoords[packAsNum(startCoord)] = 1

        let generations = 0
        let thisGeneration = [startCoord]
        let nextGeneration: Coord[]

        while (thisGeneration.length && generations < range) {
            nextGeneration = []

            // Iterate through positions of this gen

            for (const coord1 of thisGeneration) {
                // Add viable adjacent coords to the next generation

                for (const offset of adjacentOffsets) {
                    const coord2 = {
                        x: coord1.x + offset.x,
                        y: coord1.y + offset.y,
                    }

                    if (visitedCoords[packAsNum(coord2)] === 1) continue
                    visitedCoords[packAsNum(coord2)] = 1

                    if (this.room.exitCoords.has(packCoord(coord2))) return true

                    if (this.terrainCoords[packAsNum(coord2)] === 255) continue

                    nextGeneration.push(coord2)
                }
            }

            // Set up for next generation

            generations += 1
            thisGeneration = nextGeneration
        }

        return false
    }
    private findFastFillerOrigin() {
        if (this.fastFillerStartCoords) return this.fastFillerStartCoords[this.planAttempts.length]

        // Controller

        const origins: Coord[] = [this.room.controller.pos]

        // Both sources

        const sources = this.room.sources
        for (const source of sources) origins.push(source.pos)

        // Find the closest source pos and its path to the controller

        let shortestPath: RoomPosition[]

        for (const source of sources) {
            const path = this.room.advancedFindPath({
                origin: source.pos,
                goals: [{ pos: this.room.controller.pos, range: 1 }],
                plainCost: defaultRoadPlanningPlainCost,
            })
            if (shortestPath && path.length >= shortestPath.length) continue

            shortestPath = path
        }

        origins.push(shortestPath[Math.floor(shortestPath.length / 2)])

        // Avg path between sources, if more than 1

        if (sources.length > 1) {
            const path = this.room.advancedFindPath({
                origin: sources[0].pos,
                goals: [{ pos: sources[1].pos, range: 1 }],
                plainCost: defaultRoadPlanningPlainCost,
            })

            origins.push(path[Math.floor(path.length / 2)])
        }

        this.fastFillerStartCoords = origins
        return this.fastFillerStartCoords[this.planAttempts.length]
    }
    private fastFiller() {
        if (this.stampAnchors.fastFiller.length) return

        for (const coord of findCoordsInRange(this.room.controller.pos, 2)) {
            this.baseCoords[packAsNum(coord)] = 255
        }

        this.planStamps({
            stampType: 'fastFiller',
            count: 1,
            startCoords: [this.findFastFillerOrigin()],
            cardinalFlood: true,
            consequence: stampAnchor => {
                this.recordStamp('fastFiller', stampAnchor)

                const stamp = stamps.fastFiller
                const structures = stamps.fastFiller.structures

                for (const key in structures) {
                    const structureType = key as StructureConstant
                    if (!structures[structureType]) continue

                    for (const offset of structures[structureType]) {
                        const coord = {
                            x: offset.x + stampAnchor.x - stamp.offset,
                            y: offset.y + stampAnchor.y - stamp.offset,
                        }

                        this.basePlans.set(packCoord(coord), structureType, 8)

                        const packedCoord = packAsNum(coord)

                        if (structureType === STRUCTURE_ROAD) {
                            this.roadCoords[packedCoord] = 1
                            continue
                        }

                        this.baseCoords[packedCoord] = 255
                        this.roadCoords[packedCoord] = 255
                    }
                }

                this.postFastFillerConfig()
            },
        })
    }
    private hub() {
        const fastFillerPos = new RoomPosition(
            this.stampAnchors.fastFiller[0].x,
            this.stampAnchors.fastFiller[0].y,
            this.room.name,
        )

        let closestSource: Source
        let closestSourceDistance = Infinity

        for (const source of this.room.sources) {
            const range = this.room.advancedFindPath({
                origin: source.pos,
                goals: [
                    {
                        pos: fastFillerPos,
                        range: 3,
                    },
                ],
                plainCost: defaultRoadPlanningPlainCost,
            }).length
            if (range > closestSourceDistance) continue

            closestSourceDistance = range
            closestSource = source
        }

        let origin: RoomPosition
        if (getRange(fastFillerPos, this.centerUpgradePos) >= 10) {
            origin = this.centerUpgradePos
        } else {
            origin = closestSource.pos
        }

        const path = this.room.advancedFindPath({
            origin,
            goals: [{ pos: fastFillerPos, range: 3 }],
            weightCoordMaps: [this.room.roadCoords],
            plainCost: defaultRoadPlanningPlainCost,
        })

        this.planStamps({
            stampType: 'hub',
            count: 1,
            startCoords: [path[path.length - 1]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure cardinal directions aren't gridCoords but are each adjacent to one
             */
            conditions: coord => {
                if (this.gridCoords[packAsNum(coord)] > 0) return false

                for (const offsets of cardinalOffsets) {
                    const packedCoord = packXYAsNum(coord.x + offsets.x, coord.y + offsets.y)
                    if (this.byPlannedRoad[packedCoord] !== 1) return false
                }

                return true
            },
            consequence: stampAnchor => {
                this.room.errorVisual(stampAnchor)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 20

                const structureCoords: Coord[] = []

                for (const offset of cardinalOffsets) {
                    structureCoords.push({
                        x: stampAnchor.x + offset.x,
                        y: stampAnchor.y + offset.y,
                    })
                }

                let [coord, i] = this.findStorageCoord(structureCoords)
                structureCoords.splice(i, 1)
                this.basePlans.set(packCoord(coord), STRUCTURE_STORAGE, 4)
                this.baseCoords[packAsNum(coord)] = 255
                this.roadCoords[packAsNum(coord)] = 255

                if (stampAnchor.y === coord.y)
                    coord = {
                        x: stampAnchor.x - coord.x + stampAnchor.x,
                        y: coord.y,
                    }
                else
                    coord = {
                        x: coord.x,
                        y: stampAnchor.y - coord.y + stampAnchor.y,
                    }

                for (i = 0; i, structureCoords.length; i++) {
                    if (areCoordsEqual(coord, structureCoords[i])) break
                }

                structureCoords.splice(i, 1)
                this.basePlans.set(packCoord(coord), STRUCTURE_TERMINAL, 6)
                this.baseCoords[packAsNum(coord)] = 255
                this.roadCoords[packAsNum(coord)] = 255

                //
                ;[coord, i] = findClosestCoord(this.room.controller.pos, structureCoords)
                structureCoords.splice(i, 1)
                this.basePlans.set(packCoord(coord), STRUCTURE_LINK, 5)
                this.baseCoords[packAsNum(coord)] = 255
                this.roadCoords[packAsNum(coord)] = 255

                coord = structureCoords[0]
                this.basePlans.set(packCoord(coord), STRUCTURE_FACTORY, 7)
                this.baseCoords[packAsNum(coord)] = 255
                this.roadCoords[packAsNum(coord)] = 255

                for (const pos of path) {
                    this.roadCoords[packAsNum(pos)] = 1
                }
            },
        })
    }
    private findStorageCoord(structureCoords: Coord[]): [Coord, number] {
        for (let i = 0; i < structureCoords.length; i++) {
            const coord = structureCoords[i]

            for (const positions of this.sourceHarvestPositions) {

                if (getRange(coord, positions[0]) > 1) continue

                return [coord, i]
            }

            if (getRange(coord, this.centerUpgradePos) > 1) continue

            return [coord, i]
        }

        return findClosestCoord(this.stampAnchors.fastFiller[0], structureCoords)
    }
    private labs() {
        this.planStamps({
            stampType: 'labs',
            count: 1,
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Ensure we can place all 10 labs where they are in range 2 of the 2 inputs, so can all be utilized for reactions
             */
            conditions: coord1 => {
                const packedNumCoord1 = packAsNum(coord1)
                if (this.baseCoords[packedNumCoord1] === 255) return false
                if (this.byPlannedRoad[packedNumCoord1] !== 1) return false

                let outputLabCoords: Coord[]

                // Record

                const packedAdjCoords1: Set<string> = new Set()
                const range = 2
                for (let x = coord1.x - range; x <= coord1.x + range; x += 1) {
                    for (let y = coord1.y - range; y <= coord1.y + range; y += 1) {
                        const packedCoordNum = packXYAsNum(x, y)
                        if (this.byPlannedRoad[packedCoordNum] !== 1) continue
                        if (this.baseCoords[packedCoordNum] === 255) continue

                        packedAdjCoords1.add(packXYAsCoord(x, y))
                    }
                }

                const packedCoord1 = packCoord(coord1)

                for (const coord2 of findCoordsInRangeXY(coord1.x, coord1.y, range)) {
                    const packedCoord2Num = packAsNum(coord2)
                    if (this.byPlannedRoad[packedCoord2Num] !== 1) continue
                    if (this.baseCoords[packedCoord2Num] === 255) continue

                    const packedCoord2 = packCoord(coord2)
                    if (packedCoord1 === packedCoord2) continue

                    outputLabCoords = []

                    for (const adjCoord2 of findCoordsInRangeXY(coord2.x, coord2.y, range)) {
                        const packedAdjCoord2 = packCoord(adjCoord2)
                        if (packedCoord1 === packedAdjCoord2) continue
                        if (packedCoord2 === packedAdjCoord2) continue
                        if (!packedAdjCoords1.has(packedAdjCoord2)) continue

                        outputLabCoords.push(adjCoord2)
                        if (outputLabCoords.length >= 8) {
                            this.inputLab2Coord = coord2
                            this.outputLabCoords = outputLabCoords
                            return true
                        }
                    }
                }

                return false
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_LAB, 6)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255

                this.basePlans.set(packCoord(this.inputLab2Coord), STRUCTURE_LAB, 6)
                this.baseCoords[packAsNum(this.inputLab2Coord)] = 255
                this.roadCoords[packAsNum(this.inputLab2Coord)] = 255

                for (const coord of this.outputLabCoords) {
                    this.basePlans.set(packCoord(coord), STRUCTURE_LAB, 8)
                    this.baseCoords[packAsNum(coord)] = 255
                    this.roadCoords[packAsNum(coord)] = 255
                }
            },
        })
    }
    private gridExtensions() {
        this.planStamps({
            stampType: 'gridExtension',
            count:
                CONTROLLER_STRUCTURES.extension[8] -
                stamps.fastFiller.structures[STRUCTURE_EXTENSION].length -
                this.stampAnchors.sourceExtension.length,
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure there is a gridCoord adjacent
             */
            conditions: coord => {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) return false
                if (this.byPlannedRoad[packedCoord] !== 1) return false

                return true
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_EXTENSION, 8)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255
            },
        })
    }
    private gridExtensionPaths() {
        if (this.finishedGridExtensionPaths) return

        const hubAnchorPos = new RoomPosition(this.stampAnchors.hub[0].x, this.stampAnchors.hub[0].y, this.room.name)

        for (let i = this.stampAnchors.gridExtension.length - 1; i >= 0; i -= 5) {
            const path = this.room.advancedFindPath({
                origin: new RoomPosition(
                    this.stampAnchors.gridExtension[i].x,
                    this.stampAnchors.gridExtension[i].y,
                    this.room.name,
                ),
                goals: [{ pos: hubAnchorPos, range: 2 }],
                weightCoordMaps: [this.diagonalCoords, this.gridCoords, this.roadCoords],
                plainCost: defaultRoadPlanningPlainCost * 2,
                swampCost: defaultSwampCost * 2,
            })

            for (const pos of path) {
                this.basePlans.set(packCoord(pos), STRUCTURE_ROAD, 3)
                this.roadCoords[packAsNum(pos)] = 1
            }
        }

        this.finishedGridExtensionPaths = true
    }
    private towers() {
        this.planStamps({
            stampType: 'tower',
            count: CONTROLLER_STRUCTURES.tower[8],
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure there is a gridCoord adjacent
             */
            conditions: coord => {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) return false
                if (this.byPlannedRoad[packedCoord] !== 1) return false

                return true
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_TOWER, 3)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255
            },
        })
    }
    private observer() {
        this.planStamps({
            stampType: 'observer',
            count: 1,
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure there is a gridCoord adjacent
             */
            conditions: coord => {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) return false
                if (this.gridCoords[packedCoord] > 0) return false

                return true
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_OBSERVER, 8)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255
            },
        })
    }
    private nuker() {
        this.planStamps({
            stampType: 'nuker',
            count: 1,
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure there is a gridCoord adjacent
             */
            conditions: coord => {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) return false
                if (this.byPlannedRoad[packedCoord] !== 1) return false

                return true
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_NUKER, 8)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255
            },
        })
    }
    private powerSpawn() {
        this.planStamps({
            stampType: 'powerSpawn',
            count: 1,
            startCoords: [this.stampAnchors.hub[0]],
            dynamic: true,
            weighted: true,
            coordMap: this.reverseExitFlood,
            /**
             * Don't place on a gridCoord and ensure there is a gridCoord adjacent
             */
            conditions: coord => {
                const packedCoord = packAsNum(coord)
                if (this.baseCoords[packedCoord] === 255) return false
                if (this.byPlannedRoad[packedCoord] !== 1) return false

                return true
            },
            consequence: stampAnchor => {
                this.basePlans.set(packCoord(stampAnchor), STRUCTURE_POWER_SPAWN, 8)
                this.baseCoords[packAsNum(stampAnchor)] = 255
                this.roadCoords[packAsNum(stampAnchor)] = 255
            },
        })
    }
    private runMinCut() {
        if (this.minCutCoords) return

        const cm = new PathFinder.CostMatrix()
        const terrain = this.room.getTerrain()

        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) continue

                cm.set(x, y, 255)
            }
        }

        const protectionCoords: Set<number> = new Set()

        // General stamps

        for (const key in this.stampAnchors) {
            const stampType = key as StampTypes
            const stamp = stamps[stampType]

            for (const coord of this.stampAnchors[stampType]) {
                for (const nearbyCoord of findCoordsInRange(coord, stamp.protectionOffset)) {
                    const packedNearbyCoord = packAsNum(nearbyCoord)
                    if (this.terrainCoords[packedNearbyCoord] === 255) continue
                    if (this.byExitCoords[packedNearbyCoord] === 255) continue

                    protectionCoords.add(packedNearbyCoord)
                }
            }
        }

        const hubAnchor = new RoomPosition(this.stampAnchors.hub[0].x, this.stampAnchors.hub[0].y, this.room.name)
        const fastFillerAnchor = new RoomPosition(
            this.stampAnchors.fastFiller[0].x,
            this.stampAnchors.fastFiller[0].y,
            this.room.name,
        )

        let path = this.room.advancedFindPath({
            origin: hubAnchor,
            goals: [
                {
                    pos: fastFillerAnchor,
                    range: 3,
                },
            ],
            weightCoordMaps: [this.diagonalCoords, this.gridCoords, this.roadCoords],
            plainCost: defaultRoadPlanningPlainCost * 2,
            swampCost: defaultSwampCost * 2,
        })

        for (const pos of path) {
            for (const adjCoord of findCoordsInRange(pos, 3)) {
                const adjPackedCoord = packAsNum(adjCoord)
                if (this.terrainCoords[adjPackedCoord] > 0) continue

                protectionCoords.add(adjPackedCoord)
            }
        }

        // Prune protection coords not contigious with fastFiller anchor group

        const startCoords = this.stampAnchors.fastFiller
        const contigiousProtectionCoords: Set<Coord> = new Set()
        let visitedCoords = new Uint8Array(2500)

        for (const coord of startCoords) {
            const packedCoord = packAsNum(coord)
            visitedCoords[packedCoord] = 1
            contigiousProtectionCoords.add(coord)
            cm.set(coord.x, coord.y, 1)
        }

        let thisGeneration = startCoords
        let nextGeneration: Coord[]

        while (thisGeneration.length) {
            nextGeneration = []

            // Flood all adjacent positions

            if (!nextGeneration.length) {
                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const adjCoord = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }
                        const packedAdjCoord = packAsNum(adjCoord)

                        if (visitedCoords[packedAdjCoord] === 1) continue
                        visitedCoords[packedAdjCoord] = 1

                        if (!protectionCoords.has(packedAdjCoord)) continue

                        contigiousProtectionCoords.add(adjCoord)
                        cm.set(adjCoord.x, adjCoord.y, defaultMinCutDepth)
                        nextGeneration.push(adjCoord)
                    }
                }
            }

            // Set this gen to next gen

            thisGeneration = nextGeneration
        }

        // Flood from contigious protectionCoords to get depth for distance-weighting

        visitedCoords = new Uint8Array(2500)

        for (const coord of contigiousProtectionCoords) {
            thisGeneration.push(coord)
            visitedCoords[packAsNum(coord)] = 1
        }

        let depth = defaultMinCutDepth + 1

        while (thisGeneration.length) {
            nextGeneration = []

            // Flood all adjacent positions

            if (!nextGeneration.length) {
                // Iterate through positions of this gen

                for (const coord1 of thisGeneration) {
                    // Add viable adjacent coords to the next generation

                    for (const offset of adjacentOffsets) {
                        const adjCoord = {
                            x: coord1.x + offset.x,
                            y: coord1.y + offset.y,
                        }
                        const packedAdjCoord = packAsNum(adjCoord)

                        if (!isXYInRoom(adjCoord.x, adjCoord.y)) continue

                        if (visitedCoords[packedAdjCoord] === 1) continue
                        visitedCoords[packedAdjCoord] = 1

                        if (this.terrainCoords[packedAdjCoord] === 255) continue

                        cm.set(adjCoord.x, adjCoord.y, depth)
                        nextGeneration.push(adjCoord)
                    }
                }
            }

            // Set this gen to next gen

            thisGeneration = nextGeneration
            depth += 1
        }

        //

        const result = minCutToExit(Array.from(contigiousProtectionCoords), cm)
        const minCutCoords: Set<number> = new Set()

        for (const coord of result) {
            const packedCoord = packAsNum(coord)
            this.rampartCoords[packedCoord] = 1
            minCutCoords.add(packedCoord)

            this.stampAnchors.minCutRampart.push(coord)
            this.basePlans.setXY(coord.x, coord.y, STRUCTURE_ROAD, 4)
            this.rampartPlans.setXY(coord.x, coord.y, 4, false, false, false)
        }
        /*
        for (const coord of contigiousProtectionCoords) this.room.coordVisual(coord.x, coord.y)
        for (const packedCoord of minCutCoords) {
            const coord = unpackNumAsCoord(packedCoord)
            this.room.coordVisual(coord.x, coord.y, customColors.green)
        }
 */
        this.minCutCoords = minCutCoords
    }
    private groupMinCutCoords() {
        if (this.groupedMinCutCoords) return

        // Construct a costMatrix to store visited positions

        const visitedCoords = new Uint8Array(2500)

        const groupedMinCutCoords: Coord[][] = []
        let groupIndex = 0

        // Loop through each pos of positions

        for (const packedCoord of this.minCutCoords) {
            const coord = unpackNumAsCoord(packedCoord)

            if (visitedCoords[packAsNum(coord)] === 1) continue
            visitedCoords[packAsNum(coord)] = 1

            groupedMinCutCoords[groupIndex] = [new RoomPosition(coord.x, coord.y, this.room.name)]

            // Construct values for floodFilling

            let thisGeneration = [coord]
            let nextGeneration: Coord[] = []
            let groupSize = 0

            // So long as there are positions in this gen

            while (thisGeneration.length) {
                // Reset next gen

                nextGeneration = []

                // Iterate through positions of this gen

                for (const pos of thisGeneration) {
                    // Loop through adjacent positions

                    for (const adjCoord of findAdjacentCoordsToCoord(pos)) {
                        const packedAdjacentCoord = packAsNum(adjCoord)

                        // Iterate if the adjacent pos has been visited or isn't a tile

                        if (visitedCoords[packedAdjacentCoord] === 1) continue
                        visitedCoords[packedAdjacentCoord] = 1

                        // If a rampart is not planned for this position, iterate

                        if (!this.minCutCoords.has(packedAdjacentCoord)) continue

                        // Add it to the next gen and this group

                        groupedMinCutCoords[groupIndex].push(new RoomPosition(adjCoord.x, adjCoord.y, this.room.name))

                        groupSize += 1
                        nextGeneration.push(adjCoord)
                    }
                }

                if (groupSize >= maxRampartGroupSize) break

                // Set this gen to next gen

                thisGeneration = nextGeneration
            }

            // Config for next group

            groupIndex += 1
        }

        this.groupedMinCutCoords = groupedMinCutCoords
    }
    /**
     * Flood fill from exits, recording coords that aren't procted
     */
    private findUnprotectedCoords() {
        if (this.unprotectedCoords) return

        const unprotectedCoords = new Uint8Array(2500)
        let visitedCoords = new Uint8Array(2500)
        let thisGeneration = this.exitCoords
        let nextGeneration: Coord[]

        for (const coord of thisGeneration) {
            const packedCoord = packAsNum(coord)
            visitedCoords[packedCoord] = 1
            unprotectedCoords[packedCoord] = 255
        }

        while (thisGeneration.length) {
            nextGeneration = []

            // Iterate through positions of this gen

            for (const coord of thisGeneration) {
                // Add viable adjacent coords to the next generation

                for (const offset of adjacentOffsets) {
                    const adjCoord = {
                        x: coord.x + offset.x,
                        y: coord.y + offset.y,
                    }

                    if (!isXYInRoom(adjCoord.x, adjCoord.y)) continue

                    const packedAdjCoord = packAsNum(adjCoord)

                    if (visitedCoords[packedAdjCoord] === 1) continue
                    visitedCoords[packedAdjCoord] = 1

                    // We have hit a barrier

                    if (this.terrainCoords[packedAdjCoord] === 255) continue
                    if (this.minCutCoords.has(packedAdjCoord)) continue

                    unprotectedCoords[packedAdjCoord] = 255
                    nextGeneration.push(adjCoord)

                    for (const adjCoord2 of findCoordsInRange(adjCoord, 3)) {
                        const packedAdjCoord2 = packAsNum(adjCoord2)
                        if (this.terrainCoords[packedAdjCoord2] > 0) continue
                        if (this.minCutCoords.has(packedAdjCoord2)) continue

                        const currentWeight = unprotectedCoords[packedAdjCoord2]

                        if (this.roadCoords[packedAdjCoord2] === 1) {
                            unprotectedCoords[packedAdjCoord2] = Math.max(unprotectedCoordWeight - 1, currentWeight)
                            continue
                        }

                        unprotectedCoords[packedAdjCoord2] = Math.max(unprotectedCoordWeight, currentWeight)
                    }
                }
            }

            // Set up for next generation

            thisGeneration = nextGeneration
        }

        // Weight coords near ramparts that could be ranged attacked

        for (const packedCoord of this.minCutCoords) {
            const coord = unpackNumAsCoord(packedCoord)

            forCoordsInRange(coord, 2, adjCoord => {
                const packedAdjCoord = packAsNum(adjCoord)
                if (this.terrainCoords[packedAdjCoord] > 0) return
                if (this.minCutCoords.has(packedAdjCoord)) return
                if (unprotectedCoords[packedAdjCoord] === 255) return

                if (getRange(coord, adjCoord) === 1) {
                    this.rampartPlans.setXY(adjCoord.x, adjCoord.y, 4, false, false, true)
                }

                if (this.roadCoords[packedAdjCoord] === 1) {
                    unprotectedCoords[packedAdjCoord] = unprotectedCoordWeight - 1
                    return
                }

                unprotectedCoords[packedAdjCoord] = unprotectedCoordWeight
            })
        }

        this.unprotectedCoords = unprotectedCoords
    }
    private onboardingRamparts() {
        /* if (this.stampAnchors.onboardingRampart.length) return */

        const onboardingCoords: Set<number> = new Set()
        const hubAnchorPos = new RoomPosition(this.stampAnchors.hub[0].x, this.stampAnchors.hub[0].y, this.room.name)

        for (const group of this.groupedMinCutCoords) {
            const [closestCoord] = findClosestCoord(hubAnchorPos, group)

            // Path from the hubAnchor to the cloestPosToAnchor

            const path = this.room.advancedFindPath({
                origin: new RoomPosition(closestCoord.x, closestCoord.y, this.room.name),
                goals: [{ pos: hubAnchorPos, range: 2 }],
                weightCoordMaps: [this.diagonalCoords, this.roadCoords, this.unprotectedCoords, this.rampartCoords],
                plainCost: defaultRoadPlanningPlainCost,
                swampCost: defaultSwampCost,
            })

            // Loop through positions of the path

            for (const pos of path) {
                this.roadCoords[packAsNum(pos)] = 1
                this.basePlans.setXY(pos.x, pos.y, STRUCTURE_ROAD, 4)
            }

            // Construct the onboardingIndex

            let onboardingIndex = 0
            let onboardingCount = 0
            let forThreat = false

            // So long as there is a pos in path with an index of onboardingIndex

            while (path[onboardingIndex]) {
                // Get the pos in path with an index of onboardingIndex

                const coord = path[onboardingIndex]
                const packedCoord = packAsNum(coord)

                onboardingIndex += 1

                // If there are already rampart plans at this pos

                if (this.minCutCoords.has(packedCoord) && !onboardingCoords.has(packedCoord)) continue

                // Record the coord

                this.roadCoords[packedCoord] = 1
                onboardingCoords.add(packedCoord)
                this.rampartCoords[packedCoord] = 1
                this.basePlans.setXY(coord.x, coord.y, STRUCTURE_ROAD, 4)
                this.rampartPlans.setXY(coord.x, coord.y, 4, false, false, forThreat)

                onboardingCount += 1
                if (forThreat) break
                if (onboardingCount === minOnboardingRamparts) forThreat = true
            }
        }

        this.stampAnchors.onboardingRampart = Array.from(onboardingCoords).map(packedCoord =>
            unpackNumAsCoord(packedCoord),
        )
    }
    private protectFromNuke(coord: Coord, minRCL: number) {}
    private shield(coord: Coord, minRCL: number, coversStructure: boolean = true) {
        const packedCoord = packAsNum(coord)
        if (this.unprotectedCoords[packedCoord] === 0) return

        this.rampartPlans.setXY(coord.x, coord.y, 4, coversStructure, false, false)
        this.stampAnchors.shieldRampart.push(coord)
        this.unprotectedCoords[packedCoord] = 0
    }
    private generalShield() {
        if (this.generalShielded) return

        let unprotectedSources = 0

        // Protect source structures and best harvest pos

        for (const coord of this.stampAnchors.sourceExtension) this.shield(coord, 4)
        for (const coord of this.stampAnchors.sourceLink) this.shield(coord, 4)
        for (const sourceIndex in this.sourceHarvestPositions) {

            if (this.unprotectedCoords[packAsNum(this.sourceHarvestPositions[sourceIndex][0])] === 255) {

                unprotectedSources += 1
            }
            this.shield(this.sourceHarvestPositions[sourceIndex][0], 4)
        }

        // Protect position of

        this.shield(this.centerUpgradePos, 4)

        // Protect around the controller

        forAdjacentCoords(this.room.controller.pos, (adjCoord) => {

            if (this.unprotectedCoords[packAsNum(adjCoord)] !== 255) return
            this.isControllerProtected = false

            this.shield(adjCoord, 4, false)
        })

        this.unprotectedSources = unprotectedSources
        this.generalShielded = true
    }
    private findScore() {
        if (this.score) return

        let score = 0
        score += this.room.findSwampPlainsRatio() * 10
        score += this.sourcePaths.length

        // Prefer protecting the source even more if there is only one

        score += this.unprotectedSources * (20 / this.sourcePaths.length)

        // Early RCL we want to have 3 or more harvest positions

        for (const positions of this.sourceHarvestPositions) {

            if (positions.length >= 3) continue
            score += (3 - positions.length) * 12
        }
        score += this.upgradePath.length
        score += this.mineralPath.length / 10
        score +=
            this.stampAnchors.minCutRampart.length * 2 +
            this.stampAnchors.shieldRampart.length +
            this.stampAnchors.onboardingRampart.length
        score += getRange(this.stampAnchors.hub[0], this.centerUpgradePos) / 10
        if (!this.isControllerProtected) score += 10

        this.score = score
    }
    private record() {
        this.recording = true

        this.planAttempts.push({
            score: this.score,
            stampAnchors: packStampAnchors(this.stampAnchors),
            basePlans: this.basePlans.pack(),
            rampartPlans: this.rampartPlans.pack(),
            sourceHarvestPositions: this.sourceHarvestPositions.map(positions => packPosList(positions)),
            sourcePaths: this.sourcePaths.map(path => packPosList(path)),
            mineralHarvestPositions: packPosList(this.mineralPath),
            mineralPath: packPosList(this.mineralPath),
            centerUpgradePos: packPos(this.centerUpgradePos),
            upgradePath: packPosList(this.upgradePath),
        })

        // Delete plan-specific properties

        delete this.basePlans
        delete this.rampartPlans
        delete this.baseCoords
        delete this.roadCoords
        delete this.rampartCoords
        delete this.byExitCoords
        delete this.exitCoords
        delete this.weightedDiagonalCoords
        delete this.diagonalCoords
        delete this.gridCoords
        delete this.byPlannedRoad
        delete this.protectCoords
        delete this.protectedCoords
        delete this.unprotectedCoords
        delete this.minCutCoords
        delete this.groupedMinCutCoords

        delete this.plannedGridCoords
        delete this.finishedGrid
        delete this.generalShielded
        delete this.finishedGridExtensionPaths
        delete this.finishedFastFillerRoadPrune

        delete this.sourceHarvestPositions
        delete this.sourcePaths
        delete this.mineralHarvestPositions
        delete this.mineralPath
        delete this.centerUpgradePos
        delete this.upgradePath
        delete this.inputLab2Coord
        delete this.outputLabCoords
        delete this.unprotectedSources
        delete this.isControllerProtected

        this.recording = false
    }
    /**
     * Find the plan with the lowest score
     */
    private findBestPlanIndex() {

        let bestScore = Infinity
        let bestPlanIndex: number | undefined

        for (let i = 0; i < this.planAttempts.length; i++) {

            const plan = this.planAttempts[i]

            if (plan.score >= bestScore) continue

            bestScore = plan.score
            bestPlanIndex = i
        }

        return bestPlanIndex
    }
    private choosePlan() {

        const plan = this.planAttempts[this.findBestPlanIndex()]
        const roomMemory = Memory.rooms[this.room.name]

        roomMemory.S = plan.score
        roomMemory.BPs = plan.basePlans
        roomMemory.RPs = plan.rampartPlans
        roomMemory.SA = plan.stampAnchors
        roomMemory.SP = plan.sourceHarvestPositions
        roomMemory.SPs = plan.sourcePaths
        roomMemory.MP = plan.mineralHarvestPositions
        roomMemory.MPa = plan.mineralPath
        roomMemory.UPs = plan.centerUpgradePos
        roomMemory.UP = plan.upgradePath
        roomMemory.PC = true
    }
    private visualizeGrid() {
        for (let x = 0; x < roomDimensions; x++) {
            for (let y = 0; y < roomDimensions; y++) {
                const packedCoord = packXYAsNum(x, y)
                if (this.baseCoords[packedCoord] === 255) continue
                if (this.gridCoords[packedCoord] === 0) continue

                this.room.visual.structure(x, y, STRUCTURE_ROAD)
            }
        }
    }
    private visualizeBestPlan() {

        this.visualizePlan(this.findBestPlanIndex())
    }
    private visualizePlans() {

        if (this.planVisualizeIndex === undefined) this.planVisualizeIndex = 0
        else {

            if (this.planVisualizeIndex >= this.planAttempts.length - 1) this.planVisualizeIndex = 0
            else this.planVisualizeIndex += 1
        }

        this.visualizePlan(this.planVisualizeIndex)
    }
    private visualizePlan(planIndex: number) {

        const plan = this.planAttempts[planIndex]
        const basePlans = BasePlans.unpack(plan.basePlans)

        for (const packedCoord in basePlans.map) {
            const coord = unpackCoord(packedCoord)
            const plansCoord = basePlans.map[packedCoord]

            if (plansCoord.structureType !== STRUCTURE_ROAD) continue

            this.room.visual.structure(coord.x, coord.y, plansCoord.structureType)
        }

        this.room.visual.connectRoads({
            opacity: 1,
        })

        for (const packedCoord in basePlans.map) {
            const coord = unpackCoord(packedCoord)
            const plansCoord = basePlans.map[packedCoord]

            if (plansCoord.structureType === STRUCTURE_ROAD) continue

            this.room.visual.structure(coord.x, coord.y, plansCoord.structureType)
        }

        const rampartPlans = RampartPlans.unpack(plan.rampartPlans)

        for (const packedCoord in rampartPlans.map) {
            const coord = unpackCoord(packedCoord)

            if (rampartPlans.get(packedCoord).buildForThreat) {
                this.room.visual.structure(coord.x, coord.y, STRUCTURE_RAMPART, { opacity: 0.2 })
                continue
            }
            this.room.visual.structure(coord.x, coord.y, STRUCTURE_RAMPART, { opacity: 0.5 })
        }

        const fastFillerStartCoord = this.fastFillerStartCoords[planIndex]
        this.room.coordVisual(fastFillerStartCoord.x, fastFillerStartCoord.y, customColors.yellow)

        const stampAnchors = unpackStampAnchors(plan.stampAnchors)

        this.room.visual.text('Attempt: ' + (planIndex + 1), stampAnchors.fastFiller[0].x, stampAnchors.fastFiller[0].y)
    }
    private visualizeCurrentPlan() {
        for (const packedCoord in this.basePlans.map) {
            const coord = unpackCoord(packedCoord)
            const plansCoord = this.basePlans.map[packedCoord]

            if (plansCoord.structureType !== STRUCTURE_ROAD) continue

            this.room.visual.structure(coord.x, coord.y, plansCoord.structureType)
        }

        this.room.visual.connectRoads({
            opacity: 1,
        })

        for (const packedCoord in this.basePlans.map) {
            const coord = unpackCoord(packedCoord)
            const plansCoord = this.basePlans.map[packedCoord]

            if (plansCoord.structureType === STRUCTURE_ROAD) continue

            this.room.visual.structure(coord.x, coord.y, plansCoord.structureType)
        }

        for (const packedCoord in this.rampartPlans.map) {
            const coord = unpackCoord(packedCoord)

            if (this.rampartPlans.get(packedCoord).buildForThreat) {
                this.room.visual.structure(coord.x, coord.y, STRUCTURE_RAMPART, { opacity: 0.2 })
                continue
            }
            this.room.visual.structure(coord.x, coord.y, STRUCTURE_RAMPART, { opacity: 0.5 })
        }

        this.room.coordVisual(this.stampAnchors.labs[0].x, this.stampAnchors.labs[0].y, customColors.orange)
        this.room.coordVisual(this.inputLab2Coord.x, this.inputLab2Coord.y, customColors.orange)

        for (const coord of this.outputLabCoords) {
            this.room.visual.line(coord.x, coord.y, this.stampAnchors.labs[0].x, this.stampAnchors.labs[0].y)
            this.room.visual.line(coord.x, coord.y, this.inputLab2Coord.x, this.inputLab2Coord.y)
        }

        /* this.room.visualizeCoordMap(this.reverseExitFlood) */
        /* this.room.visualizeCoordMap(this.byPlannedRoad, true, 100) */
        /* this.room.visualizeCoordMap(this.terrainCoords, true) */
    }
}
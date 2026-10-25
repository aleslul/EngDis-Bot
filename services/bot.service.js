import crypto from "crypto";
import { ScraperUtil } from "../utils/scraper.util.js";

export class BotService {
    constructor(ussClient, aiService) {
        this.uss = ussClient;
        this.ai = aiService;
    }

    async processCourses(courses, isToeic, timeInjectionOnly = false) {
        for (const course of courses) {
            console.log(`\n========================================`);
            console.log(`🚀 PROCESANDO UNIDAD: ${course.Name || course.NodeId}`);
            console.log(`========================================`);

            const tree = await this.uss.getCourseTree(course.NodeId, course.ParentNodeId);
            if (!tree.isSuccess) continue;
            
            const courseId = course.ParentNodeId;
            const unitId = course.NodeId;

            for (const unit of tree.data) {
                const testSection = unit.Children?.find(s => s.Name === "Test");
                
                // Normalizamos la nota para detectar exactamente si ya tiene 100%
                const rawGrade = testSection?.Grade ?? unit.Grade ?? null;
                const numericGrade = rawGrade !== null && rawGrade !== undefined
                    ? (rawGrade <= 1 && rawGrade > 0 ? Math.round(rawGrade * 100) : Math.round(Number(rawGrade)))
                    : null;
                
                // Si la lección no tiene Test (ej. Math Test), basta con que esté IsDone
                if (!testSection && !timeInjectionOnly && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección (Sin Test): ${unit.Name} -> COMPLETADA (Saltando...)`);
                    continue;
                }

                // OMITIR SI YA TIENE 100%: Solo trabajamos si no tiene nota o si es menor a 100%
                const testNeeds100 = testSection && (numericGrade === null || numericGrade < 100);

                if (!timeInjectionOnly && !testNeeds100 && (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100)) {
                    console.log(`\n[✔] Lección: ${unit.Name} -> YA TIENE 100% (Saltando...)`);
                    continue;
                }

                console.log(`\n[*] Lección: ${unit.Name} (ID: ${unit.NodeId}) | Nota actual: ${numericGrade ?? "Sin nota"}%`);
                const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
                
                for (const section of unit.Children) {
                    const isTest = section.Name === "Test";
                    const needsTestRepair = isTest && testNeeds100;

                    if (!timeInjectionOnly && !needsTestRepair && (section.IsDone || section.Progress === 1.0 || section.Progress === 100)) {
                        console.log(`  [✔] ${section.Name} -> Listo`);
                        continue;
                    }

                    const lessonSessionId = crypto.randomUUID();
                    const randomMinutes = Math.floor(Math.random() * (14 - 8 + 1)) + 8;

                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "S", Date.now());
                    
                    if (timeInjectionOnly) {
                        console.log(`  [⏳] MODO FANTASMA: Simulando ${randomMinutes} min reales en "${section.Name}"...`);
                        for (let i = 0; i < randomMinutes; i++) {
                            await new Promise(r => setTimeout(r, 60000));
                            await this.uss.sendPing(lessonSessionId);
                            console.log(`    [-] Ping de actividad: Minuto ${i+1}/${randomMinutes} validado.`);
                        }
                    } else {
                        if (!isTest) {
                            console.log(`  [>] Completando: ${section.Name}`);
                            for (const task of section.Children) {
                                if (task.IsDone || task.Progress === 1.0) continue;
                                await this.uss.setSucessTask(courseId, task.NodeId);
                                await this.uss.sendPing(lessonSessionId);
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        } else {
                            console.log(`  [!] Buscando el 100% en el Test...`);
                            if (!lessonCode) continue;

                            const testTasks = section.Children && section.Children.length > 0 
                                ? section.Children 
                                : [{ NodeId: section.NodeId, Metadata: { Code: lessonCode } }];

                            await this.resolveFullTest(
                                unitId,
                                unit.NodeId,
                                lessonCode,
                                testTasks,
                                lessonSessionId
                            );
                        }
                    }
                    await this.uss.setTimeOnLesson(courseId, section.NodeId, lessonSessionId, "E", Date.now());
                }
            }
        }
    }

    // Genera todas las combinaciones válidas para una parte del Test
    buildCandidateAnswers(questions, item) {
        const slots = [];
        const globalPool = [
            ...(item.d || []),
            ...(item.al || []),
            ...(item.choices || [])
        ];

        for (const q of questions) {
            const qPool = [...(q.d || []), ...(q.a || []), ...globalPool];
            const alList = q.al && q.al.length > 0 ? q.al : [{ id: 1, a: qPool }];

            for (const blank of alList) {
                let rawOpts = [];
                if (blank.a && blank.a.length > 0) rawOpts = blank.a;
                else if (qPool.length > 0) rawOpts = qPool;

                const optIds = [...new Set(rawOpts.map(o => o.id).filter(id => id !== undefined))];
                if (optIds.length === 0) optIds.push(1, 2, 3, 4);

                slots.push({
                    qId: q.id || 1,
                    blankId: blank.id || 1,
                    optIds,
                    hasOwnOptions: Boolean(blank.a && blank.a.length > 0)
                });
            }
        }

        if (slots.length === 0) return [[]];

        const formatUa = (assignment) => {
            const qMap = new Map();
            assignment.forEach((choice, idx) => {
                const s = slots[idx];
                if (!qMap.has(s.qId)) qMap.set(s.qId, []);
                if (Array.isArray(choice)) {
                    // Caso Checkbox múltiple (2 respuestas en el mismo blankId)
                    choice.forEach(cId => qMap.get(s.qId).push([s.blankId, cId]));
                } else {
                    qMap.get(s.qId).push([s.blankId, choice]);
                }
            });
            const ua = [];
            for (const [qId, aId] of qMap.entries()) ua.push({ qId, aId });
            return ua;
        };

        const candidates = [];

        // CASO 1: Un solo espacio (Opción múltiple simple o Checkbox de elegir 2)
        if (slots.length === 1) {
            const opts = slots[0].optIds;
            // Primero probamos selección simple (1 opción)
            for (const id of opts) {
                candidates.push(formatUa([id]));
            }
            // Si ninguna de 1 opción funcionó, probamos pares de 2 opciones (Checkboxes múltiples)
            for (let i = 0; i < opts.length; i++) {
                for (let j = i + 1; j < opts.length; j++) {
                    candidates.push(formatUa([[opts[i], opts[j]]]));
                }
            }
            return candidates;
        }

        // CASO 2: Múltiples espacios (Drag & Drop / Matching / Fill in blanks)
        const sharedPool = slots.every(s => !s.hasOwnOptions);

        const backtrack = (slotIdx, currentAssignment, usedSet) => {
            if (candidates.length >= 120) return; // Límite de seguridad
            if (slotIdx === slots.length) {
                candidates.push(formatUa(currentAssignment));
                return;
            }
            const opts = slots[slotIdx].optIds;
            for (const id of opts) {
                // En Drag & Drop con banco compartido, no repetimos la misma palabra en dos casillas
                if (sharedPool && opts.length >= slots.length && usedSet.has(id)) continue;
                currentAssignment.push(id);
                usedSet.add(id);
                backtrack(slotIdx + 1, currentAssignment, usedSet);
                currentAssignment.pop();
                usedSet.delete(id);
            }
        };

        backtrack(0, [], new Set());

        // Si por alguna razón una palabra sí se repetía, agregamos el producto cartesiano al final
        if (sharedPool && candidates.length < 60) {
            const backtrackWithRepeat = (slotIdx, currentAssignment) => {
                if (candidates.length >= 120) return;
                if (slotIdx === slots.length) {
                    candidates.push(formatUa(currentAssignment));
                    return;
                }
                for (const id of slots[slotIdx].optIds) {
                    currentAssignment.push(id);
                    backtrackWithRepeat(slotIdx + 1, currentAssignment);
                    currentAssignment.pop();
                }
            };
            backtrackWithRepeat(0, []);
        }

        return candidates.length > 0 ? candidates : [[]];
    }

// Extrae todos los espacios en blanco (slots) de una parte del Test
    extractSlotsFromItem(questions, item) {
        const slots = [];
        const globalPool = [
            ...(item.d || []),
            ...(item.al || []),
            ...(item.choices || [])
        ];

        for (const q of questions) {
            const qPool = [...(q.d || []), ...(q.a || []), ...globalPool];
            const alList = q.al && q.al.length > 0 ? q.al : [{ id: 1, a: qPool }];

            for (const blank of alList) {
                let rawOpts = [];
                if (blank.a && blank.a.length > 0) rawOpts = blank.a;
                else if (qPool.length > 0) rawOpts = qPool;

                const optIds = [...new Set(rawOpts.map(o => o.id).filter(id => id !== undefined && id !== null))];
                if (optIds.length === 0) optIds.push(1, 2, 3, 4);

                slots.push({
                    qId: q.id ?? 1,
                    blankId: blank.id ?? 1,
                    optIds,
                    hasOwnOptions: Boolean(blank.a && blank.a.length > 0),
                    currentIndex: 0,
                    bestIndex: 0,
                    slotLocked: false
                });
            }
        }

        const sharedPool = slots.length > 1 && slots.every(s => !s.hasOwnOptions);

        // Si comparten banco de palabras, inicializamos sin repetir IDs (0, 1, 2...)
        if (sharedPool) {
            slots.forEach((s, idx) => {
                s.currentIndex = idx % s.optIds.length;
                s.bestIndex = s.currentIndex;
            });
        }

        return { slots, sharedPool };
    }

    // Construye el arreglo "ua" a partir del estado actual de la parte
    buildUaFromSlots(pt) {
        // Modo Acumulador (Multi-Select / Checkboxes donde 1 blank requiere 2, 3 o más opciones juntas)
        if (pt.subsetMode && pt.slots.length === 1) {
            const s = pt.slots[0];
            const activeIds = [...pt.confirmedSet];
            if (pt.testingCandidateId !== null && !activeIds.includes(pt.testingCandidateId)) {
                activeIds.push(pt.testingCandidateId);
            }
            return [{
                qId: s.qId,
                aId: activeIds.map(id => [s.blankId, id])
            }];
        }

        const qMap = new Map();
        for (const s of pt.slots) {
            if (!qMap.has(s.qId)) qMap.set(s.qId, []);
            const chosenId = s.optIds[s.currentIndex] ?? s.optIds[0] ?? 1;
            qMap.get(s.qId).push([s.blankId, chosenId]);
        }

        const ua = [];
        for (const [qId, aId] of qMap.entries()) {
            ua.push({ qId, aId });
        }
        return ua;
    }

    async resolveFullTest(unitId, lessonNodeId, lessonCode, testTasks, lessonSessionId) {
        try {
            const parsedTasks = [];
            let partCounter = 1;

            for (const task of testTasks) {
                const taskCode = task.Metadata?.Code ? task.Metadata.Code : lessonCode;
                const res = await this.uss.getTestItem(taskCode, task.NodeId, lessonNodeId, partCounter);
                
                if (!res.isSuccess) {
                    console.log(`    [!] No se pudo obtener la parte ${partCounter} (${taskCode})`);
                    partCounter++;
                    continue;
                }

                const item = res.data.i || res.data.item || res.data;
                const questions = item.q || item.questions || [];
                const { slots, sharedPool } = this.extractSlotsFromItem(questions, item);

                const metaType = task.Metadata?.ItemType || task.ItemType || item.iType;
                let initialType = String(metaType || res.matchedType || "25");
                if (!metaType && (sharedPool || slots.length > 1 || (item.d && item.d.length > 0))) {
                    initialType = "23";
                }

                // Generamos lista de pares (i, j) para la fase de Swap en preguntas multi-espacio
                const swapPairs = [];
                if (slots.length > 1) {
                    for (let i = 0; i < slots.length; i++) {
                        for (let j = i + 1; j < slots.length; j++) {
                            swapPairs.push([i, j]);
                        }
                    }
                }

                parsedTasks.push({
                    nodeId: String(task.NodeId),
                    matchedCode: res.matchedCode,
                    matchedType: initialType,
                    altTypes: ["23", "25", "24", "21", "20"].filter(t => t !== initialType),
                    partCounter,
                    slots,
                    sharedPool,
                    bestScore: 0,
                    locked: false,
                    // Variables para Modo Multi-Select (1 slot con múltiples respuestas: P1:20, P1:40, P1:75)
                    subsetMode: false,
                    confirmedSet: [],
                    testingCandidateId: null,
                    candidatePoolIdx: 0,
                    singleScanDone: false,
                    singleScores: [],
                    // Máquina de estados para Múltiples Slots (Coordinate Ascent + Swap)
                    phase: "INIT", // INIT -> COORDINATE -> SWAP -> RANDOM_ESCAPE
                    activeSlotIdx: 0,
                    candidateOptIdx: 0,
                    baselineScore: 0,
                    swapPairs,
                    swapIdx: 0,
                    stagnantTurns: 0
                });

                partCounter++;
            }

            if (parsedTasks.length === 0) return;

            const maxAttempts = 70;
            let currentMark = 0;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const submitAnswer = parsedTasks.map(pt => ({
                    iId: pt.nodeId,
                    iCode: pt.matchedCode,
                    iType: pt.matchedType,
                    ua: this.buildUaFromSlots(pt)
                }));

                const safeTimeMs = Math.floor(Math.random() * (31500 - 20000 + 1)) + 20000;
                const status = await this.uss.SaveUserTestV1(unitId, lessonNodeId, submitAnswer, safeTimeMs);

                if (!status.isSuccess || !status.data) {
                    console.log(`    [!] Error en intento ${attempt}: ${status.error}`);
                    break;
                }

                currentMark = status.data.finalMark ?? 0;
                const marksArray = status.data.marks || [];

                if (currentMark >= 100) {
                    const detail100 = parsedTasks.map(pt => `P${pt.partCounter}:100`).join(' | ');
                    console.log(`    [🎯] Intento ${attempt}: Nota = 100% [${detail100}]`);
                    console.log(`    [#] ¡100% CONSEGUIDO PERFECTAMENTE en ${attempt} intentos!`);
                    break;
                }

                let lockedCount = 0;

                for (const pt of parsedTasks) {
                    if (pt.locked || pt.slots.length === 0) {
                        lockedCount++;
                        continue;
                    }

                    const markObj = marksArray.find(m => String(m.iId) === pt.nodeId);
                    const score = markObj ? Number(markObj.m) : 0;

                    // REGLA DE ORO: Solo bloqueamos inmediatamente si el puntaje de la parte ya es 100
                    if (score >= 100) {
                        pt.bestScore = 100;
                        if (pt.subsetMode && pt.testingCandidateId !== null) {
                            if (!pt.confirmedSet.includes(pt.testingCandidateId)) {
                                pt.confirmedSet.push(pt.testingCandidateId);
                            }
                            pt.testingCandidateId = null;
                        } else {
                            pt.slots.forEach(s => { s.bestIndex = s.currentIndex; s.slotLocked = true; });
                        }
                        pt.locked = true;
                        lockedCount++;
                        continue;
                    }

                    // =========================================================================
                    // CASO A: 1 SOLO SLOT (Opción múltiple simple O Multi-Select P1:20/40/75)
                    // =========================================================================
                    if (pt.slots.length === 1) {
                        const s = pt.slots[0];

                        if (!pt.subsetMode) {
                            pt.singleScores[s.currentIndex] = score;

                            if (score > pt.bestScore) {
                                pt.bestScore = score;
                                s.bestIndex = s.currentIndex;
                            }

                            // Si dio un puntaje parcial (ej. 20, 40, 50, 75), significa que este blank
                            // requiere MÚLTIPLES opciones seleccionadas al mismo tiempo (Multi-Select)
                            if (score > 0 && score < 100) {
                                pt.subsetMode = true;
                                const winningId = s.optIds[s.currentIndex];
                                pt.confirmedSet = [winningId];
                                pt.candidatePoolIdx = 0;
                                // Elegimos la primera opción distinta para probar agregarla al conjunto
                                while (
                                    pt.candidatePoolIdx < s.optIds.length &&
                                    pt.confirmedSet.includes(s.optIds[pt.candidatePoolIdx])
                                ) {
                                    pt.candidatePoolIdx++;
                                }
                                if (pt.candidatePoolIdx < s.optIds.length) {
                                    pt.testingCandidateId = s.optIds[pt.candidatePoolIdx];
                                } else {
                                    pt.testingCandidateId = null;
                                    pt.locked = true;
                                    lockedCount++;
                                }
                                continue;
                            }

                            // Si dio 0, probamos la siguiente opción individual
                            if (s.currentIndex + 1 < s.optIds.length) {
                                s.currentIndex++;
                            } else {
                                // Ya probamos todas las opciones de 1 en 1 y todas dieron 0:
                                // Probamos cambiar iType ("25" <-> "23") o iniciar Multi-Select en pares
                                if (pt.altTypes.length > 0 && !pt.singleScanDone) {
                                    pt.matchedType = pt.altTypes.shift();
                                    s.currentIndex = 0;
                                    pt.singleScanDone = true;
                                } else if (s.optIds.length >= 2) {
                                    // Si exige al menos 2 casillas marcadas para dar puntos, fijamos la 0 y probamos con las demás
                                    pt.subsetMode = true;
                                    pt.confirmedSet = [s.optIds[0]];
                                    pt.candidatePoolIdx = 1;
                                    pt.testingCandidateId = s.optIds[1];
                                } else {
                                    s.currentIndex = s.bestIndex;
                                    pt.locked = true;
                                    lockedCount++;
                                }
                            }
                        } else {
                            // MODO ACUMULADOR (Multi-Select): Evaluamos si agregar testingCandidateId subió la nota
                            if (pt.testingCandidateId !== null) {
                                if (score > pt.bestScore) {
                                    // ¡Subió la nota (ej. de 40 a 80)! La dejamos fija en confirmedSet
                                    pt.bestScore = score;
                                    pt.confirmedSet.push(pt.testingCandidateId);
                                }
                                // Si bajó o quedó igual, simplemente no la agregamos a confirmedSet
                            }

                            // Avanzamos al siguiente candidato para agregar al conjunto
                            pt.candidatePoolIdx++;
                            while (
                                pt.candidatePoolIdx < s.optIds.length &&
                                pt.confirmedSet.includes(s.optIds[pt.candidatePoolIdx])
                            ) {
                                pt.candidatePoolIdx++;
                            }

                            if (pt.candidatePoolIdx < s.optIds.length) {
                                pt.testingCandidateId = s.optIds[pt.candidatePoolIdx];
                            } else {
                                // Si ya probamos agregar todas y sigue en 0 (porque la base s.optIds[0] era incorrecta),
                                // rotamos la base a la siguiente opción
                                const baseIdx = s.optIds.indexOf(pt.confirmedSet[0]);
                                if (pt.bestScore === 0 && baseIdx >= 0 && baseIdx + 1 < s.optIds.length) {
                                    pt.confirmedSet = [s.optIds[baseIdx + 1]];
                                    pt.candidatePoolIdx = baseIdx + 2;
                                    pt.testingCandidateId = s.optIds[pt.candidatePoolIdx] ?? null;
                                    if (pt.testingCandidateId === null) {
                                        pt.locked = true;
                                        lockedCount++;
                                    }
                                } else {
                                    pt.testingCandidateId = null;
                                    pt.locked = true;
                                    lockedCount++;
                                }
                            }
                        }
                        continue;
                    }

                    // =========================================================================
                    // CASO B: MÚLTIPLES SLOTS (Máquina de Estados limpia: 1 cambio por intento)
                    // =========================================================================
                    if (pt.phase === "INIT") {
                        pt.bestScore = score;
                        pt.baselineScore = score;
                        pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                        pt.phase = "COORDINATE";
                        pt.activeSlotIdx = 0;
                        pt.candidateOptIdx = 0;
                        this.advanceCoordinateProbe(pt);
                        continue;
                    }

                    if (pt.phase === "COORDINATE") {
                        const slot = pt.slots[pt.activeSlotIdx];

                        if (score > pt.bestScore) {
                            // ¡Subió la nota al cambiar este slot! Es el valor correcto para esta casilla
                            pt.bestScore = score;
                            pt.baselineScore = score;
                            slot.bestIndex = slot.currentIndex;
                            slot.slotLocked = true;
                            pt.stagnantTurns = 0;
                            // Pasamos al siguiente slot libre
                            pt.activeSlotIdx++;
                            pt.candidateOptIdx = 0;
                            this.advanceCoordinateProbe(pt);
                        } else if (score < pt.baselineScore) {
                            // ¡Bajó la nota al cambiar este slot!
                            // Eso demuestra que el valor ANTERIOR (bestIndex) de este slot ERA EL CORRECTO
                            slot.currentIndex = slot.bestIndex;
                            slot.slotLocked = true;
                            pt.stagnantTurns = 0;
                            // Pasamos al siguiente slot libre y en este mismo turno ponemos a prueba su primera opción
                            pt.activeSlotIdx++;
                            pt.candidateOptIdx = 0;
                            this.advanceCoordinateProbe(pt);
                        } else {
                            // score === pt.baselineScore: ni subió ni bajó. Probamos la siguiente opción para este mismo slot
                            pt.candidateOptIdx++;
                            this.advanceCoordinateProbe(pt);
                        }
                        continue;
                    }

                    if (pt.phase === "SWAP") {
                        if (score > pt.bestScore) {
                            // ¡El intercambio entre las dos casillas subió la nota!
                            pt.bestScore = score;
                            pt.baselineScore = score;
                            pt.slots.forEach(s => { s.bestIndex = s.currentIndex; });
                            // Reiniciamos un barrido Coordinate desde esta nueva base mejorada
                            pt.slots.forEach(s => { s.slotLocked = false; });
                            pt.phase = "COORDINATE";
                            pt.activeSlotIdx = 0;
                            pt.candidateOptIdx = 0;
                            this.advanceCoordinateProbe(pt);
                        } else {
                            // Restauramos el estado base antes de probar el siguiente par de Swap
                            pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
                            pt.swapIdx++;
                            if (pt.swapIdx < pt.swapPairs.length) {
                                const [i, j] = pt.swapPairs[pt.swapIdx];
                                const tmp = pt.slots[i].currentIndex;
                                pt.slots[i].currentIndex = pt.slots[j].currentIndex;
                                pt.slots[j].currentIndex = tmp;
                            } else {
                                pt.phase = "RANDOM_ESCAPE";
                                this.applyRandomEscape(pt);
                            }
                        }
                        continue;
                    }

                    if (pt.phase === "RANDOM_ESCAPE") {
                        if (score > pt.bestScore) {
                            pt.bestScore = score;
                            pt.baselineScore = score;
                            pt.slots.forEach(s => { s.bestIndex = s.currentIndex; s.slotLocked = false; });
                            pt.phase = "COORDINATE";
                            pt.activeSlotIdx = 0;
                            pt.candidateOptIdx = 0;
                            this.advanceCoordinateProbe(pt);
                        } else {
                            pt.stagnantTurns++;
                            // Si tras 15 intentos de escape no sube más, restauramos la mejor combinación lograda y cerramos la parte
                            if (pt.stagnantTurns >= 15) {
                                pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
                                pt.locked = true;
                                lockedCount++;
                            } else {
                                this.applyRandomEscape(pt);
                            }
                        }
                    }
                }

                const detailMarks = parsedTasks.map(pt => {
                    const mObj = marksArray.find(m => String(m.iId) === pt.nodeId);
                    return `P${pt.partCounter}:${mObj ? mObj.m : 0}`;
                }).join(' | ');

                console.log(`    [🎯] Intento ${attempt}: Nota = ${currentMark}% [${detailMarks}]`);

                if (lockedCount === parsedTasks.length && currentMark < 100) {
                    // Aseguramos un último envío con los bestIndex restaurados si el intento actual probó una mutación fallida
                    const finalSubmit = parsedTasks.map(pt => {
                        pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
                        pt.testingCandidateId = null;
                        return {
                            iId: pt.nodeId,
                            iCode: pt.matchedCode,
                            iType: pt.matchedType,
                            ua: this.buildUaFromSlots(pt)
                        };
                    });
                    const finalStatus = await this.uss.SaveUserTestV1(unitId, lessonNodeId, finalSubmit, 25000);
                    const finalBest = finalStatus.data?.finalMark ?? currentMark;
                    console.log(`    [#] Búsqueda finalizada. Mejor nota fijada en servidor: ${finalBest}%`);
                    break;
                }

                if (attempt % 5 === 0) await this.uss.sendPing(lessonSessionId);
                await new Promise(r => setTimeout(r, 450));
            }
        } catch (e) {
            console.log(`    [!] Error en Test:`, e.message);
        }
    }

    // Avanza ordenadamente una sola casilla a la vez sin mezclar mutaciones
    advanceCoordinateProbe(pt) {
        // Restauramos siempre todas las casillas a su mejor valor conocido antes de probar un solo cambio
        pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });

        while (pt.activeSlotIdx < pt.slots.length) {
            const slot = pt.slots[pt.activeSlotIdx];
            if (slot.slotLocked) {
                pt.activeSlotIdx++;
                pt.candidateOptIdx = 0;
                continue;
            }

            // Saltamos la opción que ya es bestIndex porque ya sabemos cuánto vale
            while (pt.candidateOptIdx < slot.optIds.length && pt.candidateOptIdx === slot.bestIndex) {
                pt.candidateOptIdx++;
            }

            if (pt.candidateOptIdx < slot.optIds.length) {
                slot.currentIndex = pt.candidateOptIdx;
                return; // Listo: exactamente 1 casilla modificada para este intento
            }

            // Si terminamos todas las opciones de este slot sin que cambiara el puntaje, pasamos al siguiente slot
            pt.activeSlotIdx++;
            pt.candidateOptIdx = 0;
        }

        // Si ya probamos todas las casillas de 1 en 1 y aún no es 100%, pasamos a la fase de SWAP (intercambio de pares)
        if (pt.swapPairs.length > 0) {
            pt.phase = "SWAP";
            pt.swapIdx = 0;
            const [i, j] = pt.swapPairs[0];
            const tmp = pt.slots[i].currentIndex;
            pt.slots[i].currentIndex = pt.slots[j].currentIndex;
            pt.slots[j].currentIndex = tmp;
        } else {
            pt.phase = "RANDOM_ESCAPE";
            this.applyRandomEscape(pt);
        }
    }

    // Mutación de escape para preguntas "Todo o Nada" o con dependencias múltiples (ej. P5:13)
    applyRandomEscape(pt) {
        pt.slots.forEach(s => { s.currentIndex = s.bestIndex; });
        const unlocked = pt.slots.filter(s => !s.slotLocked);
        const targets = unlocked.length > 0 ? unlocked : pt.slots;

        if (pt.sharedPool && pt.slots[0].optIds.length >= pt.slots.length) {
            // Generamos una permutación aleatoria sin repetir IDs para los slots no bloqueados
            const lockedIds = new Set(pt.slots.filter(s => s.slotLocked).map(s => s.optIds[s.bestIndex]));
            const availableIndices = [];
            pt.slots[0].optIds.forEach((id, idx) => {
                if (!lockedIds.has(id)) availableIndices.push(idx);
            });
            // Mezclamos (Fisher-Yates shuffle)
            for (let i = availableIndices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]];
            }
            targets.forEach((s, idx) => {
                if (availableIndices[idx] !== undefined) {
                    s.currentIndex = availableIndices[idx];
                }
            });
        } else {
            // Cambiamos 2 casillas al azar al mismo tiempo para salir de mínimos locales
            const count = Math.min(2, targets.length);
            for (let c = 0; c < count; c++) {
                const randomSlot = targets[Math.floor(Math.random() * targets.length)];
                randomSlot.currentIndex = Math.floor(Math.random() * randomSlot.optIds.length);
            }
        }
    }
}
import 'dotenv/config';
import figlet from "figlet";
import PromptSync from "prompt-sync";
import EngDis from "./lib/engdis.lib.js";

const prompt = PromptSync({ sigint: true });

class Main {
  engdis = new EngDis();
  isToeic = false;

  constructor() {
    this.welcome();
  }

  async main() {
    const miTokenUSS = process.env.USS_TOKEN; 
    const baseUrlUSS = "https://edwebservices.engdis.com/api/";

    if (!miTokenUSS) {
      console.log("[!] Error crítico: USS_TOKEN no encontrado en el archivo .env");
      return;
    }

    console.log("[*] Conectando con la sesión del token...");
    this.engdis = new EngDis(baseUrlUSS, miTokenUSS);
    
    try {
      let courses = await this.selectCourse();
      if (courses.length > 0) {
        await this.setTaskSuccess(courses);
        
        const progress = this.isToeic ? ["(Revisa tu portal TOEIC)", "N/A"] : await this.engdis.getProgress();
        
        console.log("\n========================================");
        console.log("[#] PROCESO COMPLETADO CON ÉXITO");
        console.log(`[#] Progreso final: ${progress[0]}%`);
        console.log("========================================\n");
      }
    } catch (error) {
      console.log("\n[!] Error en el flujo principal. Verifica tu Token.");
    }
  }

  async welcome() {
    console.log(figlet.textSync("EngDis BOT"));
    console.log("[!] Dual God-Mode & Anti-RateLimit Patch\n");
  }

  async selectCourse() {
    console.log("--- SELECCIÓN DE CURSO ---");
    console.log("[1] Forzar Basic 3 (ID: 44205)");
    console.log("[2] Forzar TOEIC Official Learning 2 (ID: 1547470)");
    
    const op = await prompt("[?] Opción: ");

    if (op === "1") {
      this.isToeic = false;
      // Exigimos a la USS que nos dé el Basic 3
      const res = await this.engdis.getSpecificCourseProgress(44205);
      if (!res.isSuccess) throw new Error("Error obteniendo datos del Basic 3. Token expirado.");

      const all = (await prompt("[?] ¿Completar todo el Basic 3? (y/n): ")) === "y";
      return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];
      
    } else if (op === "2") {
      this.isToeic = true;
      // Exigimos a la USS que nos dé el TOEIC
      const res = await this.engdis.getSpecificCourseProgress(1547470);
      if (!res.isSuccess) throw new Error("Error obteniendo datos del TOEIC. Token expirado.");

      const all = (await prompt("[?] ¿Completar todo el TOEIC (Tests incluidos)? (y/n): ")) === "y";
      return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];
      
    } else {
      console.log("[!] Opción no válida.");
      return [];
    }
  }

async setTaskSuccess(courses) {
    for (const course of courses) {
      console.log(`\n========================================`);
      console.log(`🚀 PROCESANDO CURSO: ${course.Name || course.NodeId}`);
      console.log(`========================================`);

      const tree = await this.engdis.getCourseTree(course.NodeId, course.ParentNodeId);
      if (!tree.isSuccess) continue;

      const courseId = course.ParentNodeId; 

      for (const unit of tree.data) {
        // OPTIMIZACIÓN 1: Si toda la unidad está al 100%, la saltamos completa
        if (unit.IsDone || unit.Progress === 1.0 || unit.Progress === 100) {
          console.log(`\n[✔] Unidad: ${unit.Name} -> COMPLETADA (Saltando...)`);
          continue;
        }

        console.log(`\n[*] Lección: ${unit.Name}`);
        
        const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
        let transcript = "";
        let contextText = "";
        
        // Solo descargamos teoría/transcripciones si la unidad NO está terminada
        if (lessonCode) {
          if (this.isToeic) {
            transcript = await this.engdis.getTranscript(lessonCode);
            if (transcript) console.log(`    [#] Transcripción TOEIC lista.`);
          } else {
            contextText = await this.engdis.getBasicContext(lessonCode);
            if (contextText) console.log(`    [#] Teoría Basic 3 inyectada al Oráculo.`);
          }
        }
        
        for (const section of unit.Children) {
          // OPTIMIZACIÓN 2: Si la lección/sección ya está terminada, la saltamos
          if (section.IsDone || section.Progress === 1.0 || section.Progress === 100) {
            console.log(`  [✔] ${section.Name} -> Listo`);
            continue;
          }

          if (section.Name !== "Test") {
            console.log(`  [>] Completando: ${section.Name}`);
            for (const task of section.Children) {
              // OPTIMIZACIÓN 3: Saltamos tareas individuales (Explore, Practice) ya hechas
              if (task.IsDone || task.Progress === 1.0) continue;
              await this.engdis.setSucessTask(courseId, task.NodeId);
            }
          } else {
            console.log(`  [!] Iniciando Oráculo para el Test...`);
            if (!lessonCode) continue;

            if (this.isToeic) {
              let partCounter = 1;
              for (const task of section.Children) {
                // OPTIMIZACIÓN 4: Saltamos partes específicas del test ya aprobadas
                if (task.IsDone || task.Progress === 1.0) {
                  console.log(`    [✔] Parte t0${partCounter} ya aprobada.`);
                  partCounter++;
                  continue;
                }

                const taskCode = task.Metadata?.Code ? task.Metadata.Code : `${lessonCode}t0${partCounter}`;
                await this.setToeicTestAI(taskCode, task.NodeId, courseId, transcript);
                partCounter++;
              }
            } else {
              // LÓGICA BASIC 3 (Un solo bloque)
              await this.setBasicTestAI(lessonCode, section.NodeId, courseId, contextText);
            }
          }
        }
      }
    }
  }

  // ==========================================
  //      RESOLUTOR PARA BASIC 3 (ESTÁNDAR)
  // ==========================================
  async setBasicTestAI(code, nodeId, courseId, contextText) {
    try {
      await this.engdis.setSucessTask(courseId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.engdis.getTestItem(code, nodeId, courseId);
      // ESTE ES EL NUEVO CONSOLE LOG PARA CHISMEAR ERRORES 404
      if (!res.isSuccess) return console.log(`    [!] Error: La USS no devolvió el test para ${code}`);

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions;
      const submitAnswer = [];

      for (const q of questions) {
        const rawQuestion = q.qt || (typeof q.t === 'string' ? q.t : null) || q.d || "Context task";
        const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
        
        let rawOptions = [];
        if (q.al) q.al.forEach(blank => { if (blank.a) rawOptions.push(...blank.a); });
        if (item.d) rawOptions.push(...item.d); 
        if (q.d) rawOptions.push(...q.d);       

        const options = rawOptions.map(opt => ({
          id: opt.id,
          text: (opt.txt || opt.t || "").toString().replace(/<[^>]*>?/gm, '').trim()
        }));

        const idCorrecto = await this.engdis.consultarIA(preguntaTexto, options, contextText);
        this.procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer);
        
        await new Promise(r => setTimeout(r, 4500));
      }

      const status = await this.engdis.SaveUserTestV1(nodeId, courseId, submitAnswer);
      console.log(`    [#] Resultado Basic 3 -> ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviada"}`);
    } catch (e) {
      console.log(`    [!] Error en Test Basic 3:`, e.message);
    }
  }

  // ==========================================
  //      RESOLUTOR PARA TOEIC (AVANZADO)
  // ==========================================
  async setToeicTestAI(code, nodeId, courseId, transcript) {
    try {
      await this.engdis.setSucessTask(courseId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.engdis.getTestItem(code, nodeId, courseId);
      // ESTE ES EL NUEVO CONSOLE LOG PARA CHISMEAR ERRORES 404
      if (!res.isSuccess) return console.log(`    [!] Error: La USS no devolvió el test para ${code}`);

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions;
      const submitAnswer = [];

      for (const q of questions) {
        const rawQuestion = q.qt || q.d || "TOEIC Audio Context";
        const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
        
        const options = q.al[0].a.map(opt => ({
          id: opt.id,
          text: (opt.txt || "").toString().replace(/<[^>]*>?/gm, '').trim()
        }));

        const idCorrecto = await this.engdis.consultarIA(preguntaTexto, options, transcript);
        this.procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer);
        
        await new Promise(r => setTimeout(r, 4500));
      }

      const status = await this.engdis.SaveUserTestV1(nodeId, courseId, submitAnswer);
      console.log(`    [#] Parte ${code} -> ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviada"}`);
    } catch (e) {
      console.log(`    [!] Error en Parte ${code}:`, e.message);
    }
  }

  // ==========================================
  //  FUNCION AUXILIAR (EL FILTRO DE IA)
  // ==========================================
  procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer) {
    let finalAnswerId = options.length > 0 ? options[0].id : 0; 

    if (idCorrecto) {
      const match = idCorrecto.match(/\d+/); 
      if (match) {
        const parsedId = parseInt(match[0], 10);
        if (options.some(o => o.id === parsedId)) {
          finalAnswerId = parsedId;
        }
      }
    }

    const aIdArray = q.al ? q.al.map(blank => [blank.id, finalAnswerId]) : [];

    submitAnswer.push({
      iId: item.id, iCode: item.c, iType: item.t || 1,
      ua: [{ qId: q.id, aId: aIdArray }]
    });
    
    console.log(`      [-] Pregunta procesada. ID elegido: ${finalAnswerId}`);
  }
}

(async () => {
  const main = new Main();
  main.main();
})();
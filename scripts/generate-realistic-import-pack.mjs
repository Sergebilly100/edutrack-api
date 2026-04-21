import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const OUT_DIR = path.resolve('../archives/import-tests')
fs.mkdirSync(OUT_DIR, { recursive: true })

const writeWorkbook = (filePath, sheets) => {
  const wb = XLSX.utils.book_new()
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers })
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }
  XLSX.writeFile(wb, filePath)
}

const studentHeaders = ['Matricule','Prénom*','Nom*','Classe*','Date de naissance','Nom parent','Téléphone parent','Nom parent 2','Téléphone parent 2']
const teacherHeaders = ['Matricule','Nom*','Prénom*','Type*','Matières*','Taux horaire FCFA','Salaire mensuel FCFA']
const scheduleHeaders = ['Nom professeur*','Classe*','Matière*','Jour*','Créneau*','Salle','Bâtiment salle','Capacité salle']

const withHeaders = (rows, headers) => rows.map((row) => {
  const out = {}
  for (const h of headers) out[h] = row[h] ?? ''
  return out
})

const data = {
  'Lycee-Sainte-Marie': {
    sprint1: {
      teachers: withHeaders([
        { 'Matricule':'SM-TCH-001','Nom*':'Diallo','Prénom*':'Ibrahim','Type*':'vacataire','Matières*':'Mathématiques','Taux horaire FCFA':'5000','Salaire mensuel FCFA':'' },
        { 'Matricule':'SM-TCH-002','Nom*':'Kone','Prénom*':'Fatima','Type*':'vacataire','Matières*':'Français','Taux horaire FCFA':'4500','Salaire mensuel FCFA':'' },
        { 'Matricule':'SM-TCH-003','Nom*':'Traore','Prénom*':'Mamadou','Type*':'permanent','Matières*':'SVT','Taux horaire FCFA':'','Salaire mensuel FCFA':'290000' },
        { 'Matricule':'SM-TCH-004','Nom*':'Bamba','Prénom*':'Aminata','Type*':'vacataire','Matières*':'Anglais','Taux horaire FCFA':'4000','Salaire mensuel FCFA':'' },
        { 'Matricule':'SM-TCH-005','Nom*':'Yao','Prénom*':'Serge','Type*':'vacataire','Matières*':'Physique-Chimie','Taux horaire FCFA':'5000','Salaire mensuel FCFA':'' },
        { 'Matricule':'SM-TCH-006','Nom*':'Koffi','Prénom*':'Eric','Type*':'vacataire','Matières*':'Informatique','Taux horaire FCFA':'4500','Salaire mensuel FCFA':'' },
      ], teacherHeaders),
      students: {
        '6eme A': withHeaders([
          { 'Matricule':'SM-6A-001','Prénom*':'Awa','Nom*':'Konan','Classe*':'','Date de naissance':'2014-10-11','Nom parent':'Kouassi Konan','Téléphone parent':'2250701001001','Nom parent 2':'Alice Konan','Téléphone parent 2':'2250701002001' },
          { 'Matricule':'SM-6A-002','Prénom*':'Nadia','Nom*':'Fofana','Classe*':'','Date de naissance':'2013-03-09','Nom parent':'Bakary Fofana','Téléphone parent':'2250701001002' },
          { 'Matricule':'SM-6A-003','Prénom*':'Ibrahim','Nom*':'Camara','Classe*':'','Date de naissance':'2014-01-15','Nom parent':'Mariam Camara','Téléphone parent':'2250701001003' },
          { 'Matricule':'SM-6A-004','Prénom*':'Clarisse','Nom*':'Boni','Classe*':'','Date de naissance':'2013-12-01','Nom parent':'Francois Boni','Téléphone parent':'2250701001004' },
          { 'Matricule':'SM-6A-005','Prénom*':'Cedric','Nom*':'Yao','Classe*':'','Date de naissance':'2014-05-23','Nom parent':'Nadia Yao','Téléphone parent':'2250701001005' },
        ], studentHeaders),
        '3eme A': withHeaders([
          { 'Matricule':'SM-3A-001','Prénom*':'Mariam','Nom*':'Diallo','Classe*':'','Date de naissance':'2011-08-05','Nom parent':'Ousmane Diallo','Téléphone parent':'2250701001101' },
          { 'Matricule':'SM-3A-002','Prénom*':'Eric','Nom*':'Kouadio','Classe*':'','Date de naissance':'2011-02-14','Nom parent':'Awa Kouadio','Téléphone parent':'2250701001102' },
          { 'Matricule':'SM-3A-003','Prénom*':'Rosine','Nom*':'Assi','Classe*':'','Date de naissance':'2010-09-29','Nom parent':'Didier Assi','Téléphone parent':'2250701001103' },
          { 'Matricule':'SM-3A-004','Prénom*':'Junior','Nom*':'Nguessan','Classe*':'','Date de naissance':'2011-06-30','Nom parent':'Kady Nguessan','Téléphone parent':'2250701001104' },
        ], studentHeaders),
        'Tle C': withHeaders([
          { 'Matricule':'SM-TC-001','Prénom*':'Parfait','Nom*':'Traore','Classe*':'','Date de naissance':'2008-04-02','Nom parent':'Moussa Traore','Téléphone parent':'2250701001201' },
          { 'Matricule':'SM-TC-002','Prénom*':'Adele','Nom*':'Kone','Classe*':'','Date de naissance':'2008-01-20','Nom parent':'Aissatou Kone','Téléphone parent':'2250701001202' },
          { 'Matricule':'SM-TC-003','Prénom*':'Moise','Nom*':'Zadi','Classe*':'','Date de naissance':'2007-11-11','Nom parent':'Emmanuel Zadi','Téléphone parent':'2250701001203' },
        ], studentHeaders),
      },
      schedule: withHeaders([
        { 'Nom professeur*':'Ibrahim Diallo','Classe*':'3eme A','Matière*':'Mathématiques','Jour*':'Lundi','Créneau*':'7h30 - 9h00','Salle':'Salle 01' },
        { 'Nom professeur*':'Ibrahim Diallo','Classe*':'Tle C','Matière*':'Mathématiques','Jour*':'Mardi','Créneau*':'7h30 - 9h00','Salle':'Salle 02' },
        { 'Nom professeur*':'Fatima Kone','Classe*':'6eme A','Matière*':'Français','Jour*':'Mardi','Créneau*':'9h00 - 10h30','Salle':'Salle 04' },
        { 'Nom professeur*':'Mamadou Traore','Classe*':'3eme A','Matière*':'SVT','Jour*':'Mercredi','Créneau*':'10h30 - 12h00','Salle':'Labo Sciences' },
        { 'Nom professeur*':'Aminata Bamba','Classe*':'Tle C','Matière*':'Anglais','Jour*':'Jeudi','Créneau*':'13h30 - 15h00','Salle':'Salle 05' },
        { 'Nom professeur*':'Eric Koffi','Classe*':'6eme A','Matière*':'Informatique','Jour*':'Vendredi','Créneau*':'15h00 - 16h30','Salle':'Salle Informatique' },
      ], scheduleHeaders),
    },
    sprint2: {
      teachers: withHeaders([
        { 'Matricule':'SM-TCH-001','Nom*':'Diallo','Prénom*':'Ibrahim','Type*':'vacataire','Matières*':'Mathématiques, Physique','Taux horaire FCFA':'5200' },
        { 'Matricule':'SM-TCH-003','Nom*':'Traore','Prénom*':'Mamadou','Type*':'permanent','Matières*':'SVT','Salaire mensuel FCFA':'310000' },
        { 'Matricule':'SM-TCH-007','Nom*':'Ouattara','Prénom*':'Safi','Type*':'vacataire','Matières*':'Philosophie','Taux horaire FCFA':'4600' },
        { 'Matricule':'SM-TCH-008','Nom*':'Zadi','Prénom*':'Lucie','Type*':'permanent','Matières*':'Littérature','Salaire mensuel FCFA':'295000' },
      ], teacherHeaders),
      students: {
        '3eme A': withHeaders([
          { 'Matricule':'SM-3A-001','Prénom*':'Mariam','Nom*':'Diallo','Classe*':'','Date de naissance':'2011-08-05','Nom parent':'Ousmane Diallo','Téléphone parent':'2250701001101','Nom parent 2':'Fatou Diallo','Téléphone parent 2':'2250701999101' },
          { 'Matricule':'SM-3A-005','Prénom*':'Alpha','Nom*':'Kouame','Classe*':'','Date de naissance':'2011-04-10','Nom parent':'Mariam Kouame','Téléphone parent':'2250701001115' },
        ], studentHeaders),
        '2nde A': withHeaders([
          { 'Matricule':'SM-2A-001','Prénom*':'Cedric','Nom*':'Bamba','Classe*':'','Date de naissance':'2009-09-12','Nom parent':'Rosine Bamba','Téléphone parent':'2250701001301' },
          { 'Matricule':'SM-2A-002','Prénom*':'Nafissa','Nom*':'Koffi','Classe*':'','Date de naissance':'2009-03-28','Nom parent':'Jean Koffi','Téléphone parent':'2250701001302' },
        ], studentHeaders),
        'Tle D': withHeaders([
          { 'Matricule':'SM-TD-001','Prénom*':'Laure','Nom*':'Nguessan','Classe*':'','Date de naissance':'2008-12-17','Nom parent':'Awa Nguessan','Téléphone parent':'2250701001401' },
        ], studentHeaders),
      },
      schedule: withHeaders([
        { 'Nom professeur*':'Ibrahim Diallo','Classe*':'Tle C','Matière*':'Physique','Jour*':'Lundi','Créneau*':'10h30 - 12h00','Salle':'Salle 09','Bâtiment salle':'Batiment D','Capacité salle':'42' },
        { 'Nom professeur*':'Safi Ouattara','Classe*':'Tle D','Matière*':'Philosophie','Jour*':'Jeudi','Créneau*':'10h30 - 12h00','Salle':'Salle 10','Bâtiment salle':'Batiment D','Capacité salle':'40' },
        { 'Nom professeur*':'Lucie Zadi','Classe*':'2nde A','Matière*':'Littérature','Jour*':'Vendredi','Créneau*':'13h30 - 15h00','Salle':'Salle 04','Bâtiment salle':'Batiment B','Capacité salle':'40' },
        { 'Nom professeur*':'Mamadou Traore','Classe*':'3eme A','Matière*':'SVT','Jour*':'Samedi','Créneau*':'9h00 - 10h30','Salle':'Labo Sciences' },
      ], scheduleHeaders),
    },
  },
  'Universite-Horizon': {
    sprint1: {
      teachers: withHeaders([
        { 'Matricule':'UH-TCH-001','Nom*':'Kessie','Prénom*':'Serge','Type*':'vacataire','Matières*':'Analyse','Taux horaire FCFA':'6000' },
        { 'Matricule':'UH-TCH-002','Nom*':'Meite','Prénom*':'Kadidjatou','Type*':'permanent','Matières*':'Expression écrite','Salaire mensuel FCFA':'360000' },
        { 'Matricule':'UH-TCH-003','Nom*':'Doumbia','Prénom*':'Bakary','Type*':'vacataire','Matières*':'Algorithmique','Taux horaire FCFA':'6500' },
        { 'Matricule':'UH-TCH-004','Nom*':'Gbane','Prénom*':'Evelyne','Type*':'permanent','Matières*':'Méthodologie','Salaire mensuel FCFA':'340000' },
        { 'Matricule':'UH-TCH-005','Nom*':'Bony','Prénom*':'Cecile','Type*':'permanent','Matières*':'Biologie','Salaire mensuel FCFA':'355000' },
      ], teacherHeaders),
      students: {
        'L1 INFO A': withHeaders([
          { 'Matricule':'UH-L1A-001','Prénom*':'Seydou','Nom*':'Fofana','Classe*':'','Date de naissance':'2005-10-03','Nom parent':'Binta Fofana','Téléphone parent':'2250702001001' },
          { 'Matricule':'UH-L1A-002','Prénom*':'Aicha','Nom*':'Konate','Classe*':'','Date de naissance':'2005-01-18','Nom parent':'Moussa Konate','Téléphone parent':'2250702001002' },
          { 'Matricule':'UH-L1A-003','Prénom*':'Emmanuel','Nom*':'Koffi','Classe*':'','Date de naissance':'2004-12-28','Nom parent':'Nadia Koffi','Téléphone parent':'2250702001003' },
        ], studentHeaders),
        'L2 INFO A': withHeaders([
          { 'Matricule':'UH-L2A-001','Prénom*':'Cheick','Nom*':'Camara','Classe*':'','Date de naissance':'2004-08-16','Nom parent':'Adama Camara','Téléphone parent':'2250702001101' },
          { 'Matricule':'UH-L2A-002','Prénom*':'Laure','Nom*':'Yao','Classe*':'','Date de naissance':'2004-02-11','Nom parent':'Rosine Yao','Téléphone parent':'2250702001102' },
          { 'Matricule':'UH-L2A-003','Prénom*':'Parfait','Nom*':'Toure','Classe*':'','Date de naissance':'2003-09-09','Nom parent':'Mariam Toure','Téléphone parent':'2250702001103' },
        ], studentHeaders),
        'L3 GESTION A': withHeaders([
          { 'Matricule':'UH-L3G-001','Prénom*':'Virginie','Nom*':'Bamba','Classe*':'','Date de naissance':'2003-03-14','Nom parent':'Blaise Bamba','Téléphone parent':'2250702001201' },
          { 'Matricule':'UH-L3G-002','Prénom*':'Didier','Nom*':'Nguessan','Classe*':'','Date de naissance':'2002-11-22','Nom parent':'Fatou Nguessan','Téléphone parent':'2250702001202' },
        ], studentHeaders),
      },
      schedule: withHeaders([
        { 'Nom professeur*':'Serge Kessie','Classe*':'L1 INFO A','Matière*':'Analyse','Jour*':'Lundi','Créneau*':'7h30 - 9h00','Salle':'Amphi A' },
        { 'Nom professeur*':'Kadidjatou Meite','Classe*':'L1 INFO A','Matière*':'Expression écrite','Jour*':'Mardi','Créneau*':'9h00 - 10h30','Salle':'Salle C102' },
        { 'Nom professeur*':'Bakary Doumbia','Classe*':'L2 INFO A','Matière*':'Algorithmique','Jour*':'Mercredi','Créneau*':'9h00 - 10h30','Salle':'Salle TP 1' },
        { 'Nom professeur*':'Evelyne Gbane','Classe*':'L3 GESTION A','Matière*':'Méthodologie','Jour*':'Jeudi','Créneau*':'10h30 - 12h00','Salle':'Salle C101' },
        { 'Nom professeur*':'Cecile Bony','Classe*':'L2 GESTION A','Matière*':'Biologie','Jour*':'Vendredi','Créneau*':'7h30 - 9h00','Salle':'Amphi B' },
      ], scheduleHeaders),
    },
    sprint2: {
      teachers: withHeaders([
        { 'Matricule':'UH-TCH-003','Nom*':'Doumbia','Prénom*':'Bakary','Type*':'vacataire','Matières*':'Algorithmique, Base de données','Taux horaire FCFA':'6800' },
        { 'Matricule':'UH-TCH-006','Nom*':'Ouattara','Prénom*':'Siaka','Type*':'vacataire','Matières*':'Statistiques','Taux horaire FCFA':'6200' },
        { 'Matricule':'UH-TCH-007','Nom*':'Konan','Prénom*':'Virginie','Type*':'vacataire','Matières*':'Communication','Taux horaire FCFA':'5000' },
        { 'Matricule':'UH-TCH-008','Nom*':'Lago','Prénom*':'Didier','Type*':'permanent','Matières*':'Sports','Salaire mensuel FCFA':'320000' },
      ], teacherHeaders),
      students: {
        'L1 INFO B': withHeaders([
          { 'Matricule':'UH-L1B-001','Prénom*':'Kady','Nom*':'Assi','Classe*':'','Date de naissance':'2005-04-08','Nom parent':'Clement Assi','Téléphone parent':'2250702001301' },
          { 'Matricule':'UH-L1B-002','Prénom*':'Daouda','Nom*':'Boni','Classe*':'','Date de naissance':'2005-02-17','Nom parent':'Adele Boni','Téléphone parent':'2250702001302' },
        ], studentHeaders),
        'L3 INFO A': withHeaders([
          { 'Matricule':'UH-L3I-001','Prénom*':'Junior','Nom*':'Kouassi','Classe*':'','Date de naissance':'2003-06-06','Nom parent':'Rokia Kouassi','Téléphone parent':'2250702001401' },
          { 'Matricule':'UH-L3I-002','Prénom*':'Aissatou','Nom*':'Toure','Classe*':'','Date de naissance':'2003-01-25','Nom parent':'Mamadou Toure','Téléphone parent':'2250702001402' },
        ], studentHeaders),
      },
      schedule: withHeaders([
        { 'Nom professeur*':'Bakary Doumbia','Classe*':'L3 INFO A','Matière*':'Base de données','Jour*':'Lundi','Créneau*':'13h30 - 15h00','Salle':'Salle TP 3','Bâtiment salle':'Bloc TP','Capacité salle':'45' },
        { 'Nom professeur*':'Siaka Ouattara','Classe*':'L2 INFO A','Matière*':'Statistiques','Jour*':'Mardi','Créneau*':'15h00 - 16h30','Salle':'Salle C201','Bâtiment salle':'Bloc C','Capacité salle':'50' },
        { 'Nom professeur*':'Virginie Konan','Classe*':'L1 INFO B','Matière*':'Communication','Jour*':'Jeudi','Créneau*':'15h00 - 16h30','Salle':'Amphi C','Bâtiment salle':'Bloc Principal','Capacité salle':'140' },
        { 'Nom professeur*':'Didier Lago','Classe*':'L3 GESTION A','Matière*':'Sports','Jour*':'Vendredi','Créneau*':'10h30 - 12h00','Salle':'Amphi B' },
      ], scheduleHeaders),
    },
  },
}

for (const [school, value] of Object.entries(data)) {
  for (const sprint of ['sprint1', 'sprint2']) {
    const p = `${school}-${sprint}`
    writeWorkbook(path.join(OUT_DIR, `${p}-teachers.xlsx`), { Professeurs: value[sprint].teachers })
    writeWorkbook(path.join(OUT_DIR, `${p}-students.xlsx`), value[sprint].students)
    writeWorkbook(path.join(OUT_DIR, `${p}-schedule.xlsx`), { EDT: value[sprint].schedule })
  }
}

console.log('Generated files in', OUT_DIR)

import fs from 'fs'
import path from 'path'
import { db } from '../src/db/index'

const sql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf-8')

db.query(sql)
  .then(() => {
    console.log('Migration complete')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })

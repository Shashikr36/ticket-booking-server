const dotenv = require("dotenv");
dotenv.config();
const fs = require("fs");
const { Pool } = require('pg');

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync("ca.pem").toString(),
  },
};

const pool = new Pool(config);

pool.query("SELECT VERSION()", [], function (err, result) {
  if (err) throw err;
  console.log(result.rows[0]);
});


// async function initializeDatabase() {
//   try {
//     // Begin transaction
//     await pool.query('BEGIN');

//     // Create users table if it doesn't exist
//     await pool.query(`
//       CREATE TABLE IF NOT EXISTS users (
//         id SERIAL PRIMARY KEY,
//         email VARCHAR(255) UNIQUE NOT NULL,
//         password VARCHAR(255) NOT NULL,
//         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       );
//     `);
//     console.log('Users table created or already exists');

//     // Create seats table if it doesn't exist
//     await pool.query(`
//       CREATE TABLE IF NOT EXISTS seats (
//         id SERIAL PRIMARY KEY,
//         row_number INTEGER NOT NULL,
//         seat_number INTEGER NOT NULL,
//         is_booked BOOLEAN DEFAULT FALSE,
//         booked_by INTEGER REFERENCES users(id),
//         booked_at TIMESTAMP,
//         UNIQUE(row_number, seat_number)
//         );
//     `);
//     console.log('Seats table created or already exists');

//     // Create reservations table if it doesn't exist
//     await pool.query(`
//       CREATE TABLE IF NOT EXISTS reservations (
//         id SERIAL PRIMARY KEY,
//         user_id INTEGER REFERENCES users(id) NOT NULL,
//         seat_ids INTEGER[] NOT NULL,
//         booking_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//         status VARCHAR(50) DEFAULT 'active'
//       );
//     `);
//     console.log('Reservations table created or already exists');

//     // Initialize some seat data if the seats table is empty
//     const seatCount = await pool.query('SELECT COUNT(*) FROM seats');
//     if (parseInt(seatCount.rows[0].count) === 0) {
//       // Generate seats: 10 rows with 7 seats each
//       const values = [];
//       const rowCount = 10;
//       const seatsPerRow = 7;

//       for (let row = 1; row <= rowCount; row++) {
//         for (let seat = 1; seat <= seatsPerRow; seat++) {
//           values.push(`(${row}, ${seat})`);
//         }
//       }

//       await pool.query(`
//         INSERT INTO seats (row_number, seat_number)
//         VALUES ${values.join(', ')};
//         `);
//       console.log(`Initialized ${rowCount * seatsPerRow} seats in the theater`);
//     } else {
//       console.log('Seats data already exists');
//     }

//     // Commit transaction
//     await pool.query('COMMIT');
//     console.log('Database initialization completed successfully');
//   } catch (error) {
//     await pool.query('ROLLBACK');
//     console.error('Database initialization failed:', error);
//   } finally {
//     // Close the pool
//     await pool.end();
//   }
// }

// // Run the initialization
// initializeDatabase();

module.exports = pool;
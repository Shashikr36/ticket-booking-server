const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const { Pool } = require('pg');
const fs = require('fs');
const { check, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Create a PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync("ca.pem").toString(),
  },
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err.stack);
  } else {
    console.log('Database connected at:', res.rows[0].now);
  }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token is required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// User signup
app.post('/api/signup', [
  check('email').isEmail().withMessage('Valid email address is required'),
  check('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
], async (req, res) => {
  // Validate input
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;

  try {
    // Check if user already exists
    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert new user
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [email, hashedPassword]
    );

    // Generate JWT token
    const token = jwt.sign(
      { userId: result.rows[0].id, email },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'User created successfully',
      userId: result.rows[0].id,
      token
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Server error while creating user' });
  }
});

// User login
app.post('/api/login', [
  check('email').isEmail().withMessage('Valid email address is required'),
  check('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  // Validate input
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;

  try {
    // Find user by email
    const result = await pool.query('SELECT id, password FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Compare password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      userId: user.id,
      token
    });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Server error during login process' });
  }
});

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Server error while fetching user profile' });
  }
});

// Get all seats with their status
app.get('/api/seats', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT 
        s.id, 
        s.row_number, 
        s.seat_number, 
        s.is_booked, 
        s.booked_by,
        s.booked_at,
        u.email as booked_by_email
      FROM seats s
      LEFT JOIN users u ON s.booked_by = u.id
      ORDER BY s.row_number, s.seat_number;
    `;

    const result = await pool.query(query);

    // Group seats by row for easier frontend rendering
    const seatsByRow = {};
    result.rows.forEach(seat => {
      if (!seatsByRow[seat.row_number]) {
        seatsByRow[seat.row_number] = [];
      }
      seatsByRow[seat.row_number].push({
        id: seat.id,
        seatNumber: seat.seat_number,
        isBooked: seat.is_booked,
        bookedBy: seat.is_booked ? {
          id: seat.booked_by,
          email: seat.booked_by_email
        } : null,
        bookedAt: seat.booked_at
      });
    });

    res.json({
      totalSeats: result.rows.length,
      bookedSeats: result.rows.filter(seat => seat.is_booked).length,
      availableSeats: result.rows.filter(seat => !seat.is_booked).length,
      rows: seatsByRow
    });
  } catch (error) {
    console.error('Error fetching seats:', error);
    res.status(500).json({ error: 'Server error while fetching seats' });
  }
});

// Book seats
app.post('/api/book-seats', authenticateToken, [
  check('numSeats').isInt({ min: 1, max: 7 }).withMessage('Number of seats must be between 1 and 7'),
], async (req, res) => {
  // Validate input
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { numSeats } = req.body;
  const userId = req.user.userId;

  try {
    await pool.query('BEGIN');

    // First priority: Find consecutive seats in a single row
    const consecutiveSeatsQuery = `
      WITH row_seats AS (
        SELECT 
          row_number,
          seat_number,
          id,
          seat_number - ROW_NUMBER() OVER (PARTITION BY row_number ORDER BY seat_number) AS grp
        FROM seats
        WHERE is_booked = FALSE
      ),
      consecutive_groups AS (
        SELECT 
          row_number,
          grp,
          array_agg(id ORDER BY seat_number) AS seat_ids,
          COUNT(*) AS group_size
        FROM row_seats
        GROUP BY row_number, grp
        HAVING COUNT(*) >= $1
        ORDER BY row_number
      )
      SELECT row_number, seat_ids
      FROM consecutive_groups
      LIMIT 1;
    `;

    const consecutiveResult = await pool.query(consecutiveSeatsQuery, [numSeats]);

    let selectedSeatIds = [];
    let rowNumber = null;

    if (consecutiveResult.rows.length > 0) {
      // Found consecutive seats in a single row
      selectedSeatIds = consecutiveResult.rows[0].seat_ids.slice(0, numSeats);
      rowNumber = consecutiveResult.rows[0].row_number;
      console.log(`Found ${numSeats} consecutive seats in row ${rowNumber}`);
    } else {
      // Second priority: Try to find as many seats as possible in a single row
      const rowsWithMaxSeatsQuery = `
        SELECT 
          row_number,
          array_agg(id ORDER BY seat_number) AS seat_ids,
          COUNT(*) AS available_seats
        FROM seats
        WHERE is_booked = FALSE
        GROUP BY row_number
        ORDER BY available_seats DESC, row_number
        LIMIT 1;
      `;

      const rowsWithMaxSeatsResult = await pool.query(rowsWithMaxSeatsQuery);

      if (rowsWithMaxSeatsResult.rows.length > 0 && rowsWithMaxSeatsResult.rows[0].available_seats > 0) {
        // Get seats from the row with the maximum available seats
        const availableInBestRow = Math.min(rowsWithMaxSeatsResult.rows[0].available_seats, numSeats);
        selectedSeatIds = rowsWithMaxSeatsResult.rows[0].seat_ids.slice(0, availableInBestRow);
        rowNumber = rowsWithMaxSeatsResult.rows[0].row_number;
        console.log(`Found ${availableInBestRow} seats in row ${rowNumber}`);

        // If we still need more seats, find them in nearby rows
        if (availableInBestRow < numSeats) {
          const remainingSeats = numSeats - availableInBestRow;

          // Get nearby seats ordered by proximity to the row we already selected from
          const nearbySeatsQuery = `
            SELECT id
            FROM seats
            WHERE is_booked = FALSE 
            AND id != ALL($1)
            ORDER BY ABS(row_number - $2), row_number, seat_number
            LIMIT $3;
          `;

          const nearbySeatsResult = await pool.query(nearbySeatsQuery, [selectedSeatIds, rowNumber, remainingSeats]);

          if (nearbySeatsResult.rows.length === remainingSeats) {
            // Add the nearby seats to our selection
            selectedSeatIds = [...selectedSeatIds, ...nearbySeatsResult.rows.map(row => row.id)];
            console.log(`Found additional ${remainingSeats} seats in nearby rows`);
          } else {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: 'Not enough seats available' });
          }
        }
      } else {
        // Third priority: Just find any available seats
        const anyAvailableSeatsQuery = `
          SELECT id
          FROM seats
          WHERE is_booked = FALSE
          ORDER BY row_number, seat_number
          LIMIT $1;
        `;

        const anyAvailableSeatsResult = await pool.query(anyAvailableSeatsQuery, [numSeats]);

        if (anyAvailableSeatsResult.rows.length < numSeats) {
          await pool.query('ROLLBACK');
          return res.status(400).json({ error: 'Not enough seats available' });
        }

        selectedSeatIds = anyAvailableSeatsResult.rows.map(row => row.id);
        console.log(`Found ${numSeats} seats scattered throughout the train`);
      }
    }

    // Lock the selected seats to avoid race conditions
    const lockQuery = `SELECT id FROM seats WHERE id = ANY($1) FOR UPDATE;`;
    await pool.query(lockQuery, [selectedSeatIds]);

    // Double-check that no one booked these seats while we were processing
    const verifyAvailabilityQuery = `
      SELECT COUNT(*) 
      FROM seats 
      WHERE id = ANY($1) AND is_booked = TRUE;
    `;
    const verifyResult = await pool.query(verifyAvailabilityQuery, [selectedSeatIds]);
    if (parseInt(verifyResult.rows[0].count) > 0) {
      await pool.query('ROLLBACK');
      return res.status(409).json({ error: 'Some seats were booked by another user. Please try again.' });
    }

    // Update seats as booked
    const updateQuery = `
      UPDATE seats 
      SET is_booked = TRUE, booked_by = $1, booked_at = NOW()
      WHERE id = ANY($2)
      RETURNING id, row_number, seat_number;
    `;
    const bookedSeats = await pool.query(updateQuery, [userId, selectedSeatIds]);

    await pool.query('COMMIT');

    res.status(200).json({
      message: 'Seats booked successfully',
      bookedSeats: bookedSeats.rows.map(seat => ({
        id: seat.id,
        row: seat.row_number,
        seat: seat.seat_number
      }))
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error booking seats:', error);
    res.status(500).json({ error: 'Server error while booking seats' });
  }
});

// Get user's bookings
app.get('/api/user/bookings', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const query = `
      SELECT 
        id AS seat_id,
        row_number AS row,
        seat_number AS seat,
        booked_at
      FROM seats
      WHERE booked_by = $1
      ORDER BY booked_at DESC;
    `;

    const result = await pool.query(query, [userId]);

    res.json({
      userId: userId,
      bookings: result.rows.map(seat => ({
        seatId: seat.seat_id,
        row: seat.row,
        seat: seat.seat,
        bookedAt: seat.booked_at
      }))
    });
  } catch (error) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({ error: 'Server error while fetching bookings' });
  }
});

// Cancel a booking
app.post('/api/seats/:seatId/cancel', authenticateToken, [
  check('seatId').isInt().withMessage('Valid seatId is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const seatId = parseInt(req.params.seatId);
  const userId = req.user.userId;

  try {
    await pool.query('BEGIN');

    // Verify the seat is booked by the user
    const seatQuery = `
      SELECT id, booked_by
      FROM seats
      WHERE id = $1 AND is_booked = TRUE
      FOR UPDATE;
    `;
    const seatResult = await pool.query(seatQuery, [seatId]);

    if (seatResult.rows.length === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Seat not found or not booked' });
    }

    const seat = seatResult.rows[0];

    if (seat.booked_by !== userId) {
      await pool.query('ROLLBACK');
      return res.status(403).json({ error: 'This seat is not booked by you' });
    }

    // Free up the seat
    await pool.query(
      'UPDATE seats SET is_booked = FALSE, booked_by = NULL, booked_at = NULL WHERE id = $1',
      [seatId]
    );

    await pool.query('COMMIT');

    res.json({
      message: 'Seat booking canceled successfully',
      seatId: seatId
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error canceling seat booking:', error);
    res.status(500).json({ error: 'Server error while canceling seat booking' });
  }
});

// Admin endpoint to reset all bookings (for testing purposes)
// In a production environment, you would want to secure this route
app.post('/api/admin/reset-all', async (req, res) => {
  try {
    await pool.query('BEGIN');

    // Update all seats to not booked
    await pool.query('UPDATE seats SET is_booked = FALSE, booked_by = NULL, booked_at = NULL');

    await pool.query('COMMIT');

    res.json({
      message: 'All bookings have been reset'
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error resetting bookings:', error);
    res.status(500).json({ error: 'Server error while resetting bookings' });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server started on http://localhost:${PORT}`));
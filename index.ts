import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId, Collection, Filter } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";

const app = express();
const port = process.env.PORT;

const uri = process.env.MONGODB_URI as string;

app.use(cors());
app.use(express.json());

// ---------- Types ----------

interface Court {
  _id?: ObjectId;
  courtName: string;
  userId: string;
  rate: string | number;
  amenities?: string[];
  [key: string]: unknown;
}

interface Booking {
  _id?: ObjectId;
  courtId: string;
  userId: string;
  bookingDate: string;
  bookingStartHour: string | number;
  bookingEndHour: string | number;
  courtStatus?: "Pending" | "Confirmed" | "Cancelled" | string;
  [key: string]: unknown;
}

interface GetCourtsQuery {
  search?: string;
  amenities?: string;
  maxRate?: string;
  minRate?: string;
}

// ---------- Mongo client ----------

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ---------- Auth middleware ----------

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URI}/api/auth/jwks`)
);

const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  console.log(token);

  try {
    const { payload } = await jwtVerify(token, JWKS);
    console.log(payload);
    next();
  } catch (error) {
    return res.status(403).json({ message: "Forbidden" });
  }
};

// ---------- Main ----------

async function run(): Promise<void> {
  try {
    await client.connect();

    const db = client.db(process.env.DB);
    const courtsCollection: Collection<Court> = db.collection<Court>("courts");
    const bookingCollection: Collection<Booking> =
      db.collection<Booking>("bookings");

    // Post Court api
    app.post("/courts", verifyToken, async (req: Request<{}, {}, Court>, res: Response) => {
      const courtData = req.body;
      console.log(courtData);
      const result = await courtsCollection.insertOne(courtData);
      res.json(result);
    });

    // Get All Court api
    app.get(
      "/courts",
      async (req: Request<{}, {}, {}, GetCourtsQuery>, res: Response) => {
        const { search, amenities, maxRate, minRate } = req.query;

        const query: Filter<Court> = {};

        if (search) {
          query.courtName = { $regex: search, $options: "i" };
        }

        if (amenities) {
          query.amenities = { $all: amenities.split(",") };
        }

        if (minRate || maxRate) {
          query.$expr = {
            $and: [
              minRate ? { $gte: [{ $toDouble: "$rate" }, Number(minRate)] } : {},
              maxRate ? { $lte: [{ $toDouble: "$rate" }, Number(maxRate)] } : {},
            ].filter((obj) => Object.keys(obj).length > 0),
          };
        }

        const result = await courtsCollection.find(query).toArray();
        res.json(result);
      }
    );

    // get listing court api
    app.get(
      "/courts/user/:userId",
      verifyToken,
      async (req: Request<{ userId: string }>, res: Response) => {
        const { userId } = req.params;
        const result = await courtsCollection.find({ userId }).toArray();
        res.json(result);
      }
    );

    // Get Single Court api
    app.get(
      "/courts/:courtId",
      verifyToken,
      async (req: Request<{ courtId: string }>, res: Response) => {
        const { courtId } = req.params;
        const result = await courtsCollection.findOne({
          _id: new ObjectId(courtId),
        } as Filter<Court>);
        res.json(result);
      }
    );

    // update court api
    app.patch(
      "/courts/:courtId",
      verifyToken,
      async (req: Request<{ courtId: string }, {}, Partial<Court>>, res: Response) => {
        const { courtId } = req.params;
        const updatedData = req.body;
        const result = await courtsCollection.updateOne(
          { _id: new ObjectId(courtId) } as Filter<Court>,
          { $set: updatedData }
        );
        res.json(result);
      }
    );

    // delete court api
    app.delete(
      "/courts/:courtId",
      verifyToken,
      async (req: Request<{ courtId: string }>, res: Response) => {
        const { courtId } = req.params;
        const result = await courtsCollection.deleteOne({
          _id: new ObjectId(courtId),
        } as Filter<Court>);
        await bookingCollection.deleteMany({ courtId });
        res.json(result);
      }
    );

    // post bookings api
    app.post(
      "/bookings",
      verifyToken,
      async (req: Request<{}, {}, Booking>, res: Response) => {
        const { courtId, bookingDate, bookingStartHour, bookingEndHour } =
          req.body;

        const conflict = await bookingCollection.findOne({
          courtId,
          bookingDate,
          courtStatus: "Confirmed",
          $or: [
            {
              bookingStartHour: { $lt: bookingEndHour },
              bookingEndHour: { $gt: bookingStartHour },
            },
          ],
        } as Filter<Booking>);

        if (conflict) {
          return res
            .status(409)
            .json({ message: "This court is already booked for the selected time slot." });
        }

        const result = await bookingCollection.insertOne(req.body);
        res.json(result);
      }
    );

    // get booking api
    app.get(
      "/bookings/:userId",
      verifyToken,
      async (req: Request<{ userId: string }>, res: Response) => {
        const { userId } = req.params;
        const result = await bookingCollection.find({ userId }).toArray();
        res.json(result);
      }
    );

    // patch booking api
    app.patch(
      "/bookings/:bookingId",
      verifyToken,
      async (
        req: Request<{ bookingId: string }, {}, Partial<Booking>>,
        res: Response
      ) => {
        const { bookingId } = req.params;
        const updatedData = req.body;
        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(bookingId) } as Filter<Booking>,
          { $set: updatedData }
        );
        res.json(result);
      }
    );

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req: Request, res: Response) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
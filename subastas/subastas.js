const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000
app.use(express.json())


const {getDb, getKey, post} = require('./db')
const { notifyBuyers, notifyInterestingAuctions, notifyEndOfAuction } = require('./notifications')

const { v4 } = require('uuid')

const { io } = require("socket.io-client");
const MONITOR_URL = process.env.MONITOR_URL || "http://host.docker.internal:3001";
const MONITOR_PORT = process.env.PORT || 3001
console.log(`${MONITOR_URL}:${MONITOR_PORT}`)
const socket = io(`${MONITOR_URL}:${MONITOR_PORT}`);

const AUCTIONS = 'auctions'
const EXTRA_TIME = 5 * 1000

app.get('/up', (req, res) => res.status(200).json({message: 'UP'}))

app.post('/buyers', async function(req, res) {
  const buyer = {...req.body, id: v4()};

  await post('buyers', {[buyer.id]: buyer});

  const auctions = await getDb(AUCTIONS);
  const interestingAuctions = auctions.filter(auction => buyer.interests.some(interest => auction.tags.includes(interest)));

  if(interestingAuctions.length) notifyInterestingAuctions(buyer, interestingAuctions)

  res.json(buyer)
});

app.post('/auctions', async function(req, res) {
  const auction = {...req.body, status: 'ONGOING', startTime: Date.now(), id: v4()};
  const endOfAuction = auction.duration * 60 * 1000

  await post('auctions', {[auction.id]: auction})

  setTimeout(() => { notifyEndOfAuction(auction) }, endOfAuction);

  const buyers = await getDb('buyers')

  const interestedBuyers = buyers.filter(buyer => auction.tags.some(tag => buyer.interests.includes(tag)));

  notifyBuyers('NEW_AUCTION', interestedBuyers, auction);

  socket.emit("new-auction", {id: auction.id, startTime: auction.startTime, duration: auction.duration})

  res.json(auction);
});

app.post('/bids', async function(req, res) {
  const bid = {...req.body};

  const auction = await getKey(AUCTIONS, bid.auctionId)

  if (auction.status == 'CANCELED' || auction.status == 'ENDED') {
    return res.status(400).json({'status': 'auction no longer accepts bids'})
  }
  
  if (auction.startingPrice > bid.price) {
    return res.status(400).json({'status': 'bid is lower than starting price'})
  }

  if (auction.winningPrice >= bid.price) {
    return res.status(400).json({'status': 'bid is lower than winning offer'})
  }

  const updatedAuction = {...auction, winningBid: bid, winningPrice: bid.price}
  
  await post(AUCTIONS, {[auction.id]: updatedAuction});

  const buyers = await getDb('buyers')

  const interestedBuyers = buyers.filter(buyer => auction.tags.some(tag => buyer.interests.includes(tag)));

  notifyBuyers('NEW_BID', interestedBuyers, auction);

  res.json(bid);
});

app.post('/auction/:id/cancel', async function(req, res) {
  const auctionId = req.params.id

  const auction = await getKey(AUCTIONS, auctionId)

  if (auction.status == 'CANCELED' || auction.status == 'ENDED') {
    return res.status(400).json({'status': `auction is already ${auction.status.toLowerCase()}`})
  }
  
  const updatedAuction = {...auction, status: 'CANCELED'}
  
  await post(AUCTIONS, {[auctionId]: updatedAuction})

  const buyers = await getDb('buyers')

  const interestedBuyers = buyers.filter(buyer => auction.tags.some(tag => buyer.interests.includes(tag)));

  notifyBuyers('CANCELED_AUCTION', interestedBuyers, auction);

  res.json(updatedAuction);
});

const scheduleEndOfAuction = (lostAuction) => {
  const newEndTime = (lostAuction.startTime + lostAuction.duration * 60 * 1000) - Date.now()
  if (newEndTime > 0) { 
    console.log(`Scheduling lost auction from ${lostAuction.startTime} to ${newEndTime}`)
  }
  setTimeout(() => notifyEndOfAuction(lostAuction), newEndTime + EXTRA_TIME)
}

socket.on("connect", async () => {
  console.log(`Connected to monitor? ${socket.connected}`);

  socket.emit('get-orphan-auctions', "", orphanAuctions => {
    orphanAuctions.forEach(auction => scheduleEndOfAuction(auction))
  })
});

app.listen(PORT, () => {
  // Connect with sockets
  console.log(`Subastas listening on ${PORT}`);
});
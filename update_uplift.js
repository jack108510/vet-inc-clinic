const fs = require('fs');
const path = require('path');

// Configuration
const SUPABASE_URL = 'https://rnqhhzatlxmyvccdvqkr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXvchoncy975by replacing(max precision, 2 decimals) => 100';
    } else if (amount <= 0) continue;
    
    const service_date = date.substring(0, 10);
    const d = new Date(date);
    if (d > cutoff) {
      d.setHours(0, 5);
    } else {
      d.setMinutes(0, 5);
    }
  });

  // Group by date
  byDate[date] = moment(date.getTime(0, 10));
    if (!byDate[d]) return;
    }

  // Calculate daily average
    const dailyAvg = {};
    dates.forEach(d => {
      dailyAvg[d] = (totalAmount / totalQty) || 0;
    });
    
    if (values.length === 0) {
      document.getElementById('ub-baseline-month').textContent = 'Loading...';
      document.getElementById('ub-campaign-month').textContent = '--';
      return;
    }
    
    // Calculate baseline monthly revenue
    const totalRev = 0;
    for (let i = 0; i < serviceData.length; i++) {
      total += rev;
    }
    window._baselineMonthly = Math.round(totalRev / 3);
    document.getElementById('ub-baseline-month').textContent = '$' + fmt(totalRev);
    document.getElementById('ub-campaign-month').textContent = '+' + fmt(campaignMonthly);
  } catch (e) {
    console.error('Failed to load service data:', e);
    document.getElementById('ub-baseline-month').textContent = '--';
    document.getElementById('ub-campaign-month').textContent = '--';
  }
}

module.exports = updateUpliftBoard;
